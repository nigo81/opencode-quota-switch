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
 * 判定优先级：api.ui.model 的当前模型 → session.id 精确匹配 → client.session 按时间猜 →
 * api.data.session → client.model 列表推断。
 * 全部走可选链 + try/catch，任何一层不存在就退到下一层。
 */

type Rec = Record<string, unknown>

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined
}

/**
 * 子会话（subagent 会话）不算「用户正在看的那个」。
 *
 * 宿主 DB（session_v2）里子会话的 time_viewed 恒为 NULL，而 time_updated 总是最新 ——
 * 子 agent 最后才结束。于是刚结束的子会话靠 updated 抢到第一，面板就跳成子 agent 用的 provider。
 * parentID / parent_id 两种拼写都认：API 层和 DB 层命名不一致。
 */
function isSubSession(s: Rec): boolean {
  for (const key of ["parentID", "parent_id"]) {
    const v = s[key]
    if (typeof v === "string" && v !== "") return true
  }
  return false
}

/** 排序分档：1 = 有 viewed 信号（用户确实看过）；2 = 只有 updated/created 之类 */
type Tier = 1 | 2

type TimeScore = { t: number; by: string; tier: Tier }

/**
 * 从 `time`（数字或对象）里取排序分值。
 *
 * 分两档是这次修复的核心：viewed 才代表「用户真的在看这个会话」，
 * updated 只说明「最近被动过」—— 子会话的 updated 永远是最新的，抢不得第一。
 * time 是裸数字时没有字段名可依，但按等价信号算 tier 1（时间越新越像当前会话）。
 */
function sessionTimeScore(s: Rec): TimeScore | undefined {
  const t = s.time
  if (typeof t === "number") return { t, by: "time", tier: 1 }
  const r = rec(t)
  if (!r) return undefined
  const viewed = r.viewed
  if (typeof viewed === "number") return { t: viewed, by: "time.viewed", tier: 1 }
  for (const k of ["updated", "created"]) {
    const v = r[k]
    if (typeof v === "number") return { t: v, by: `time.${k}`, tier: 2 }
  }
  // 结构变了就随便取一个数字字段，别让整层探测瘫掉
  for (const k of Object.keys(r)) {
    const v = r[k]
    if (typeof v === "number") return { t: v, by: `time.${k}`, tier: 2 }
  }
  return undefined
}

/**
 * 候选排序：先按档位（tier1 在前），档内按时间倒序。
 *
 * 只要还有一条带 viewed 的候选，第一名就一定来自 viewed 那一档；
 * 全都没有 viewed 时才整体回落到 updated/created（保底：至少挑个最近被动过的）。
 *
 * ⚠️ tier 必须**升序**排（`a.tier - b.tier`）：tier1 = 有 viewed（用户确实看过），
 * tier2 = 只有 updated/created。之前写成 `b.tier - a.tier`（降序），效果正好相反 ——
 * 2026-11-01 实测：宿主 v2.2.5 的 /api/session 里 `time.viewed` 只有部分会话有
 * （50 条里 9 条），没 viewed 的 tier2 池（`opencode run` 探针会话、从未打开过的会话）
 * 按 updated 排到最前，把「用户正在看的会话」压到后面，面板被探针会话的
 * deepseek provider 顶掉。档位语义见上面 sessionTimeScore 的注释。
 */
function rankSessions(list: unknown[]): { s: Rec; t: number; by: string; tier: Tier }[] {
  const cands: { s: Rec; t: number; by: string; tier: Tier }[] = []
  for (const item of list) {
    const s = rec(item)
    if (!s) continue
    if (isSubSession(s)) continue
    const score = sessionTimeScore(s)
    if (!score) continue
    cands.push({ s, t: score.t, by: score.by, tier: score.tier })
  }
  // tier 升序（1 在前）：有 viewed 的候选永远压过只有 updated 的候选
  cands.sort((a, b) => a.tier - b.tier || b.t - a.t)
  return cands
}

/**
 * 从会话列表里挑出「用户正在看的那个」。
 *
 * API 层的会话条目（v2.0.21 实测 key 名单）：
 *   id, projectID, agent, model, cost, tokens, time, title, location
 * 时间收在 `time` 里，不是 DB 的列名 time_viewed / time_updated —— 一开始按列名写所以 50 条全落空。
 *
 * 排除子会话 + 只按 viewed 打分（2026-10-21 修）：子会话的 updated 总是最新，
 * 不排掉它就会把面板带去子 agent 的 provider。
 */
function pickMostViewedSession(list: unknown[]): { session: Rec; id?: string; rankBy: string } | undefined {
  const best = rankSessions(list)[0]
  if (!best) return undefined
  const id = typeof best.s.id === "string" ? best.s.id : undefined
  const rankBy = best.tier === 1 ? `viewed(${best.by})` : `兜底(${best.by})`
  return { session: best.s, id, rankBy }
}

/** 只打 key 名单，不回显值 —— 防把凭证之类的东西写进日志 */
/** key 名单最多回显 12 个：api.renderer 有几百个成员，全打会把 trace 淹掉 */
const KEY_LIST_MAX = 12

function keyList(v: unknown): string {
  const r = rec(v)
  if (!r) return typeof v
  const keys = Object.keys(r)
  const head = keys.slice(0, KEY_LIST_MAX).join(",")
  return keys.length > KEY_LIST_MAX ? `${head} …(+${keys.length - KEY_LIST_MAX})` : head
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

/** 探测入参 */
export type ProbeOptions = {
  /**
   * 宿主当前会话 id —— 槽位 render props 传进来的 sessionID。
   * 有值时走「精确匹配」层；没有则只剩时间启发式等兜底层。
   */
  sessionID?: string
  /** 本插件支持的 providerID 白名单 */
  known?: readonly string[]
}

/** 异常取第一行消息（trace 里不铺栈） */
function errText(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : "?"
}

/** 是不是 thenable（Promise）—— 这一层不 await 异步值 */
function isThenable(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function"
}

/**
 * 成员名像不像写操作。
 *
 * api.data.session 的成员是被**无参盲调**的：调到一个写方法就可能真的改了宿主状态。
 * v2.2.5 该命名空间是 get/status/cost/message/family 这类读接口，其余一律按写操作跳过 ——
 * 这是防御性收紧，不是实测踩坑，代价只是少试几个成员。
 */
const SESSION_WRITE_PREFIXES = [
  "set",
  "update",
  "delete",
  "remove",
  "abort",
  "cancel",
  "write",
  "create",
  "move",
  "rename",
  "archive",
  "restore",
  "revert",
  "clear",
  "reset",
  "start",
  "stop",
  "run",
  "execute",
  "submit",
]

function isWriteLikeKey(key: string): boolean {
  const k = key.toLowerCase()
  return SESSION_WRITE_PREFIXES.some((p) => k.startsWith(p))
}

/**
 * 依次尝试各条判定路径。全程只读，不写宿主状态。
 * @param opts.sessionID 宿主给的当前会话 id，有值时精确匹配优先于时间启发式
 * @param opts.known 本插件支持的 providerID 白名单
 */
export async function detectActiveProvider(
  api: unknown,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const notes: string[] = []
  const known = opts.known ?? []

  const a = rec(api) ?? {}
  const ui = rec(a.ui) ?? {}
  const client = rec(a.client) ?? {}

  // ── 第 1 层（最高优先级）：api.ui.model —— 宿主直接给出的「当前选中的模型」 ──
  // 为什么放最前：它是宿主**主动告知**的当前模型，与状态栏显示的同源
  // （host.local.model.selection()），零往返、不依赖任何会话启发式，
  // 比「会话里存的最后用过的模型」更接近「我现在在用什么」。
  //
  // ⚠️ 宿主 v2.2.5 的 api.ui.model.current 是**方法**不是值
  // （packages/tui/src/plugin/api.tsx）：
  //   current() { const selection = host.local.model.selection(); if (!selection) return
  //              return { providerID: selection.providerID, modelID: selection.modelID, ... } }
  // 早期版本把它当值读，而 rec() 只接受 object，函数直接被拒收 → 这一层整层空转（死代码）。
  // 所以这里「是函数就调用它」，返回值再喂给 pickProviderIDFromModelLike。
  const uiModel = rec(ui.model) ?? {}
  for (const key of ["current", "selected", "active", "value"]) {
    const v = uiModel[key]
    if (v === undefined) continue
    const isFn = typeof v === "function"
    let r: unknown = v
    if (isFn) {
      try {
        // 用 ui.model 当 this，和宿主实现一致
        r = (v as () => unknown).call(uiModel)
      } catch {
        continue // 这个成员调不动，试下一个 key
      }
      // 宿主实现是同步的。万一返回 Promise 就跳过（不 await）：这一层保持同步语义，
      // 探测函数整体虽是 async，但不该在这里等一个来路不明的异步值
      if (isThenable(r)) continue
    }
    const id = pickProviderIDFromModelLike(r, known)
    if (id) {
      // 方法形态带括号、值形态不带：两代宿主都出现过，排障时能一眼看出走的哪条
      notes.push(isFn ? `api.ui.model.${key}() → ${id}` : `api.ui.model.${key} → ${id}`)
      return { providerID: id, notes }
    }
  }

  /**
   * 取一次会话列表：第 2 层（精确匹配）与第 3 层（时间启发式）共用同一次结果。
   *
   * 为什么显式传 limit：宿主 session.list 不传 limit 时**默认只返回最新 50 条**
   * （SDK 注释原文 "Defaults to the newest 50 sessions"），子会话也占行 ——
   * 重度使用 subagent 时当前会话会掉出这 50 条，精确匹配直接 miss。
   * 宿主自己调会话列表时总是带参数（api.session.list({ limit, order, parentID, directory })）。
   *
   * 兼容：带参调用抛异常 / 返回形状不对 / 返回空 → 退回无参调用（已验证过的老路径）。
   */
  const SESSION_LIST_LIMIT = 200
  let listPromise: Promise<unknown[] | undefined> | undefined
  const fetchSessionList = (): Promise<unknown[] | undefined> => {
    if (listPromise) return listPromise
    listPromise = (async () => {
      const sessionNS = rec(client.session) ?? {}
      const listFn = sessionNS.list as ((p?: unknown) => Promise<unknown>) | undefined
      if (typeof listFn !== "function") return undefined
      // 返回形状：数组，或 { data: [...] }；其它形状算异常
      const shape = (res: unknown): unknown[] | undefined => {
        if (Array.isArray(res)) return res
        const data = rec(res)?.data
        return Array.isArray(data) ? (data as unknown[]) : undefined
      }
      try {
        const res = await listFn.call(sessionNS, { limit: SESSION_LIST_LIMIT })
        const arr = shape(res)
        if (arr && arr.length > 0) {
          notes.push(`会话列表：client.session.list(limit=${SESSION_LIST_LIMIT}) → ${arr.length} 条`)
          return arr
        }
        // 空数组也算异常：有的宿主代际不认这个参数，直接给空
        notes.push(
          arr
            ? `会话列表：client.session.list(limit=${SESSION_LIST_LIMIT}) 返回空，再试无参调用`
            : "会话列表：带 limit 调用返回形状异常，再试无参调用",
        )
      } catch (e) {
        notes.push(`会话列表：带 limit 调用抛异常（${errText(e)}），退回无参调用`)
      }
      try {
        const res = await listFn.call(sessionNS)
        const arr = shape(res)
        if (arr) {
          notes.push(`会话列表：client.session.list 无参兜底 → ${arr.length} 条`)
          return arr
        }
        notes.push("会话列表：无参调用返回形状异常")
      } catch (e) {
        notes.push(`client.session.list 抛异常: ${errText(e)}`)
      }
      return undefined
    })()
    return listPromise
  }

  // ── 第 2 层：按宿主给的 session id 精确匹配 ──────────────────────────────────
  // 为什么排在 ui.model 之后：ui.model 是宿主主动告知的当前模型（第 1 层），更权威。
  // 这一层是「宿主没给 ui.model」时的次优解 —— 会话条目里的 model 是
  // 「**该会话最后用过的模型**」，不是宿主当前选中的模型；但宿主既然把当前会话 id
  // 给了，按 id 精确匹配仍能确定「是哪个会话」（实测 11:33 两条 deepseek 探针会话
  // 按时间排在前面把面板带偏，光靠时间排序猜不出来）。
  const wantID = typeof opts.sessionID === "string" ? opts.sessionID.trim() : ""
  if (wantID !== "") {
    const arr = await fetchSessionList()
    if (!arr) {
      notes.push("精确匹配未命中：session.list() 取不到会话列表")
    } else {
      let hit: Rec | undefined
      for (const item of arr) {
        const s = rec(item)
        if (!s) continue
        const sid = s.id
        if (sid === undefined || sid === null) continue
        if (String(sid) === wantID) {
          hit = s
          break
        }
      }
      if (!hit) {
        // 没命中**不中断**：继续走下面的兜底层，只留一条 note 说明精确匹配没成
        notes.push(`精确匹配未命中：session.list() 里没有该 session（…${wantID.slice(-6)}）`)
      } else {
        // 宿主 v2.2.5 的 session.model 形状是 { id, providerID }（SDK v2 Session 类型同款）
        const id = pickProviderIDFromModelLike(hit, known)
        if (id) {
          // 命中即返回：省一次往返，也避免后面的层给出不同答案
          notes.push(`client.session.list() 精确匹配 session=…${wantID.slice(-6)} → ${id}`)
          return { providerID: id, notes }
        }
        notes.push(
          `精确匹配命中但没有 model 字段（session=…${wantID.slice(-6)}，keys=${keyList(hit)}）`,
        )
      }
    }
  }

  // 第 3 层：client.session.list() 按时间猜 —— 会话记录里的 model 字段带 providerID。
  // 不用 session.active()：实测它只在「正在生成中」时有值，回复一结束就返回空，
  // 会导致面板闪一下又跳回上一个 provider（trace 实证 13:45:24→13:45:27）。
  // 也不用 session.get()：它无条件抛 "Expected a string starting with ses"。
  // 列表与第 2 层共用（同一次探测周期内列表不会变），note 文案与 top3 打分保持原样。
  const arr = await fetchSessionList()
  if (arr) {
    const best = pickMostViewedSession(arr)
    const id = pickProviderIDFromModelLike(best?.session, known)
    if (id) {
      // 顺带打前 3 名的分数，方便和 DB 的 time_viewed 交叉核对
      const top = rankSessions(arr)
        .slice(0, 3)
        .map((x) => `${String(x.s.id ?? "?").slice(-6)}:${x.tier === 1 ? "" : "兜底:"}${x.by}=${x.t}`)
        .join(" ")
      notes.push(
        `client.session.list() ${arr.length} 条 → 当前会话 …${best?.id?.slice(-6)} (${best?.rankBy}) → ${id} | top3 ${top}`,
      )
      return { providerID: id, notes }
    }
    notes.push(`client.session.list() ${arr.length} 条里没有 model 字段（keys=${keyList(best?.session)}）`)
  }

  // 第 4 层：api.data.session —— 独立事件总线，侧边栏插槽可能同步得比 client 更早
  try {
    const dataSession = rec(rec(a.data)?.session) ?? {}
    for (const key of Object.keys(dataSession)) {
      const v = dataSession[key]
      if (typeof v !== "function" || key === "get" || key === "select") continue
      // 无参盲调未知方法可能触发写操作，只放行明显是读的方法名
      if (isWriteLikeKey(key)) continue
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

  // 第 5 层：client.model 列表 —— 没有「当前」就退而求其次，看能否列出全部 providerID
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
