/**
 * 活跃 provider 探测：v2.0.21 宿主没有 api.state，原来的「读会话最后一条消息」路线彻底失效
 * （trace 实测 `render 被调用 session=(none)`，槽位 render 回调根本不传 session_id）。
 *
 * 真实可用入口（trace 实测成员）：
 *   api.client = { server, location, agent, plugin, session, message, model, generate,
 *                  provider, integration, mcp, credential, project, form, permission,
 *                  file, command, skill, rpc, event }
 *   api.data   = { on, listen, session, project, shell, location }
 *   api.ui     = { dialog, toast, format, router, panel, tabs, model, slot }
 *
 * 判定优先级：ui.model 的当前模型 → client.session 当前会话的最近消息 → client.model 列表推断。
 * 全部走可选链 + try/catch，任何一层不存在就退到下一层。
 */

type Rec = Record<string, unknown>

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined
}

/**
 * 从会话列表里挑出「用户正在看的那个」。
 *
 * API 层的会话条目（v2.0.21 实测 key 名单）：
 *   id, projectID, agent, model, cost, tokens, time, title, location
 * 时间收在 `time` 里，不是 DB 的列名 time_viewed / time_updated —— 一开始按列名写所以 50 条全落空。
 */
function pickMostViewedSession(list: unknown[]): { session: Rec; id?: string; rankBy: string } | undefined {
  let best: { s: Rec; t: number; by: string } | undefined
  for (const item of list) {
    const s = rec(item)
    if (!s) continue
    const score = sessionTimeScore(s)
    if (!score) continue
    if (!best || score.t > best.t) best = { s, t: score.t, by: score.by }
  }
  if (!best) return undefined
  const id = typeof best.s.id === "string" ? best.s.id : undefined
  return { session: best.s, id, rankBy: best.by }
}

/** 从 `time`（数字或对象）里取排序分值。viewed 优先，回落 updated。 */
function sessionTimeScore(s: Rec): { t: number; by: string } | undefined {
  const t = s.time
  if (typeof t === "number") return { t, by: "time" }
  const r = rec(t)
  if (!r) return undefined
  for (const k of ["viewed", "updated", "created"]) {
    const v = r[k]
    if (typeof v === "number") return { t: v, by: `time.${k}` }
  }
  // 结构变了就随便取一个数字字段，别让整层探测瘫掉
  for (const k of Object.keys(r)) {
    const v = r[k]
    if (typeof v === "number") return { t: v, by: `time.${k}` }
  }
  return undefined
}

/** 只打 key 名单，不回显值 —— 防把凭证之类的东西写进日志 */
function keyList(v: unknown): string {
  const r = rec(v)
  return r ? Object.keys(r).join(",") : typeof v
}

/**
 * 从「当前模型」取值。宿主可能给对象，也可能直接给字符串
 * （如 "minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview"），两种都要认。
 *
 * @param known 本插件支持的 providerID 白名单。裸字符串只有在白名单里才算数 ——
 *        否则 api.data.session.status() 返回的 "idle" 会被当成 providerID。
 */
function pickProviderIDFromModelLike(m: unknown, known?: readonly string[]): string | undefined {
  if (typeof m === "string") return providerIDFromModelString(m, known)
  const r = rec(m)
  if (!r) return undefined
  for (const key of ["providerID", "providerId", "provider_id"]) {
    const v = r[key]
    if (typeof v === "string" && v !== "") return v
  }
  // 模型条目常带 { info: { providerID } }、{ model: { providerID, id } }（会话记录实测形状）
  for (const key of ["info", "model"]) {
    const sub = rec(r[key])
    if (!sub) continue
    const v = pickProviderIDFromModelLike(sub, known)
    if (v) return v
  }
  for (const key of ["modelID", "modelId", "id", "name", "label"]) {
    const v = r[key]
    if (typeof v === "string" && v !== "") {
      const fromString = providerIDFromModelString(v, known)
      if (fromString) return fromString
    }
  }
  return undefined
}

/**
 * "providerID/model-name" → "providerID"。
 * 裸字符串（不含斜杠）只有在 known 白名单里才算 providerID —— 挡掉 "idle" 这类状态词。
 */
function providerIDFromModelString(s: string, known?: readonly string[]): string | undefined {
  const t = s.trim()
  if (!looksLikeProviderID(t)) return undefined
  const slash = t.indexOf("/")
  if (slash > 0) return t.slice(0, slash)
  if (known?.includes(t)) return t
  return undefined
}

/**
 * 挡掉「长得像 id 但不是 providerID」的东西。
 * 之前把会话 id（ses_xxx）当成了 providerID，导致面板永远回落到 GLM。
 */
function looksLikeProviderID(s: string): boolean {
  if (s === "" || s.length > 80) return false
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9._-]+)*$/.test(s)) return false
  // opencode 的各类实体 id 都不是 providerID
  for (const p of ["ses_", "msg_", "prt_", "per_", "cmt_"]) if (s.startsWith(p)) return false
  return true
}

/** 从会话消息里取最近一条带 providerID 的消息 */
function providerIDFromMessages(payload: unknown, known?: readonly string[]): string | undefined {
  const messages = Array.isArray(payload) ? payload : (rec(payload)?.data as unknown[] | undefined)
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = rec(messages[i])
    if (!r) continue
    const info = rec(r.info) ?? r
    // 消息是 { info: { providerID, modelID, role } } 或 { ... } 两种形状
    for (const key of ["providerID", "providerId"]) {
      const v = info[key]
      if (typeof v === "string" && v !== "") return v
    }
    const modelStr = info.modelID ?? info.modelId
    if (typeof modelStr === "string") {
      const fromString = providerIDFromModelString(modelStr, known)
      if (fromString) return fromString
    }
  }
  return undefined
}

export type ProbeResult = {
  providerID?: string
  /** 每层探测的结论，写进 trace 便于排障 */
  notes: string[]
}

/**
 * 依次尝试各条判定路径。全程只读，不写宿主状态。
 * @param preferIDs 上层已知的候选（来自 render props 等），命中就直接用
 */
/**
 * 一次性把宿主 API 的形状全打出来。只在 setup 后跑一次，
 * 免得每 3s 轮询刷屏。只打 key 名单，不回显值。
 */
export async function dumpApiSurface(api: unknown): Promise<string[]> {
  const out: string[] = []
  const a = rec(api) ?? {}
  const shape = (label: string, v: unknown) => out.push(`  ${label} = ${keyList(v)}`)

  shape("api.storage.store", (rec(a.storage) as Rec | undefined)?.store)
  shape("api.storage.memory", (rec(a.storage) as Rec | undefined)?.memory)
  shape("api.data.session", (rec(a.data) as Rec | undefined)?.session)
  shape("api.data.project", (rec(a.data) as Rec | undefined)?.project)
  shape("api.location", a.location)
  shape("api.attention", a.attention)
  shape("api.app", a.app)
  shape("api.renderer", a.renderer)
  shape("api.ui.panel", (rec(a.ui) as Rec | undefined)?.panel)
  shape("api.ui.tabs", (rec(a.ui) as Rec | undefined)?.tabs)

  // 会话列表项到底有哪些字段
  const client = rec(a.client) ?? {}
  const listFn = (rec(client.session) as Rec | undefined)?.list as (() => Promise<unknown>) | undefined
  if (typeof listFn === "function") {
    try {
      const list = await listFn.call(rec(client.session))
      const arr = Array.isArray(list) ? list : ((rec(list)?.data as unknown[] | undefined) ?? [])
      out.push(`  session.list()[0] keys = ${keyList(arr[0])}`)
      out.push(`  session.list()[0].time = ${JSON.stringify((rec(arr[0]) as Rec | undefined)?.time ?? null)}`)
      if (arr.length > 1) out.push(`  session.list()[1] keys = ${keyList(arr[1])}`)
    } catch (e) {
      out.push(`  session.list() 抛异常: ${e instanceof Error ? e.message.split("\n")[0] : "?"}`)
    }
  }

  // storage 里如果存着当前会话/模型，直接读出来（只读，不写）
  const store = ((rec(a.storage) as Rec | undefined)?.store ?? undefined) as Rec | undefined
  for (const key of Object.keys(store ?? {})) {
    const fn = store![key]
    if (typeof fn !== "function") {
      out.push(`  storage.store.${key} = ${typeof fn}`)
      continue
    }
    try {
      const v = await (fn as () => unknown).call(store)
      out.push(`  storage.store.${key}() = ${typeof v === "string" ? v : keyList(v)}`)
    } catch (e) {
      out.push(`  storage.store.${key}() 抛异常: ${e instanceof Error ? e.message.split("\n")[0] : "?"}`)
    }
  }
  return out
}

export async function detectActiveProvider(
  api: unknown,
  preferIDs: (string | undefined)[] = [],
  known: readonly string[] = [],
): Promise<ProbeResult> {
  const notes: string[] = []
  for (const id of preferIDs) {
    if (typeof id === "string" && id !== "") {
      notes.push(`render props 直接给出 ${id}`)
      return { providerID: id, notes }
    }
  }

  const a = rec(api) ?? {}
  const ui = rec(a.ui) ?? {}
  const client = rec(a.client) ?? {}

  // 第 1 层：ui.model —— TUI 自己就知道当前选中的模型（实测 v2.0.21 恒为 undefined，仅作兜底保留）
  const uiModel = rec(ui.model) ?? {}
  for (const key of ["current", "selected", "active", "value"]) {
    const id = pickProviderIDFromModelLike(uiModel[key], known)
    if (id) {
      notes.push(`api.ui.model.${key} → ${id}`)
      return { providerID: id, notes }
    }
  }

  // 第 2 层：client.session.list() —— 会话记录里的 model 字段带 providerID。
  // 不用 session.active()：实测它只在「正在生成中」时有值，回复一结束就返回空，
  // 会导致面板闪一下又跳回上一个 provider（trace 实证 13:45:24→13:45:27）。
  // 也不用 session.get()：它无条件抛 "Expected a string starting with ses"。
  const sessionNS = rec(client.session) ?? {}
  const listFn = sessionNS.list as (() => Promise<unknown>) | undefined
  if (typeof listFn === "function") {
    try {
      const list = await listFn.call(sessionNS)
      const arr = Array.isArray(list) ? list : ((rec(list)?.data as unknown[] | undefined) ?? [])
      const best = pickMostViewedSession(arr)
      const id = pickProviderIDFromModelLike(best?.session, known)
      if (id) {
        // 顺带打前 3 名的分数，方便和 DB 的 time_viewed 交叉核对
        const top = arr
          .map((s) => {
            const r = rec(s) ?? {}
            const sc = sessionTimeScore(r)
            return sc ? { id: String(r.id ?? "?").slice(-6), t: sc.t, by: sc.by } : undefined
          })
          .filter((x): x is { id: string; t: number; by: string } => x !== undefined)
          .sort((x, y) => y.t - x.t)
          .slice(0, 3)
          .map((x) => `${x.id}:${x.by}=${x.t}`)
          .join(" ")
        notes.push(
          `client.session.list() ${arr.length} 条 → 当前会话 …${best?.id?.slice(-6)} (${best?.rankBy}) → ${id} | top3 ${top}`,
        )
        return { providerID: id, notes }
      }
      notes.push(`client.session.list() ${arr.length} 条里没有 model 字段（keys=${keyList(best?.session)}）`)
    } catch (e) {
      notes.push(`client.session.list 抛异常: ${e instanceof Error ? e.message.split("\n")[0] : "?"}`)
    }
  }

  // 第 3 层：api.data.session —— 独立事件总线，侧边栏插槽可能同步得比 client 更早
  try {
    const dataSession = rec(rec(a.data)?.session) ?? {}
    for (const key of Object.keys(dataSession)) {
      const v = dataSession[key]
      if (typeof v !== "function" || key === "get" || key === "select") continue
      let r: unknown
      try {
        r = await (v as () => Promise<unknown>).call(dataSession)
      } catch {
        continue // 无参调用不了的下一个方法
      }
      const id = pickProviderIDFromModelLike(r, known) ?? providerIDFromMessages(r, known)
      if (id) {
        notes.push(`api.data.session.${key}() → ${id}`)
        return { providerID: id, notes }
      }
    }
    notes.push(`api.data.session 成员=[${Object.keys(dataSession).join(",")}] 未命中`)
  } catch (e) {
    notes.push(`api.data.session 抛异常: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 第 4 层：client.model 列表 —— 没有「当前」就退而求其次，看能否列出全部 providerID
  try {
    const modelNS = rec(client.model) ?? {}
    const listFn = (modelNS.list ?? modelNS.available) as (() => Promise<unknown>) | undefined
    if (typeof listFn === "function") {
      const list = await listFn.call(modelNS)
      const arr = Array.isArray(list) ? list : []
      const ids = new Set<string>()
      for (const m of arr) {
        const id = pickProviderIDFromModelLike(m, known)
        if (id) ids.add(id)
      }
      notes.push(`api.client.model 列表里出现的 providerID=[${[...ids].join(",")}]（无「当前」语义，仅供对照）`)
    }
  } catch (e) {
    notes.push(`api.client.model 抛异常: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { notes }
}
