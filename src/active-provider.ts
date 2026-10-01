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

/** 广度一层地把对象里的零参函数结果打出来，只看形状不回显敏感字段 */
function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]"
    return `array(${v.length})<${shapeOf(v[0], depth + 1)}>`
  }
  if (typeof v === "function") return "function"
  if (typeof v !== "object") return typeof v
  if (depth >= 2) return "{…}"
  return `{${Object.keys(v as Rec)
    .slice(0, 12)
    .map((k) => `${k}:${shapeOf((v as Rec)[k], depth + 1)}`)
    .join(",")}}`
}

/** 在一个命名空间里找出看起来像「当前模型」的字段 */
function pickProviderIDFromModelLike(m: unknown): string | undefined {
  const r = rec(m)
  if (!r) return undefined
  for (const key of ["providerID", "providerId", "provider_id"]) {
    const v = r[key]
    if (typeof v === "string" && v !== "") return v
  }
  // 模型条目常带 { info: { providerID } } 或 { modelID: "provider/model" }
  const info = rec(r.info)
  if (info) {
    for (const key of ["providerID", "providerId"]) {
      const v = info[key]
      if (typeof v === "string" && v !== "") return v
    }
  }
  for (const key of ["modelID", "modelId", "id"]) {
    const v = r[key]
    if (typeof v === "string" && v.includes("/")) return v.split("/")[0]
  }
  return undefined
}

/** 从会话消息里取最近一条带 providerID 的消息 */
function providerIDFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = rec(messages[i])
    if (!r) continue
    const direct = pickProviderIDFromModelLike(r)
    if (direct) return direct
    const info = rec(r.info)
    if (info) {
      const v = pickProviderIDFromModelLike(info)
      if (v) return v
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
export async function detectActiveProvider(api: unknown, preferIDs: (string | undefined)[] = []): Promise<ProbeResult> {
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

  // 第 1 层：ui.model —— TUI 自己就知道当前选中的模型
  const uiModel = rec(ui.model) ?? {}
  for (const key of ["current", "selected", "active", "value"]) {
    const id = pickProviderIDFromModelLike(uiModel[key])
    if (id) {
      notes.push(`api.ui.model.${key} → ${id}`)
      return { providerID: id, notes }
    }
  }
  notes.push(`api.ui.model 成员=[${Object.keys(uiModel).join(",")}] 无 current/selected`)

  // 第 2 层：client.session 当前会话的最近消息
  const sessionNS = rec(client.session) ?? {}
  try {
    const listFn = sessionNS.list as (() => Promise<unknown>) | undefined
    if (typeof listFn === "function") {
      const list = await listFn.call(sessionNS)
      const arr = Array.isArray(list) ? list : ((rec(list)?.data as unknown[] | undefined) ?? [])
      const first = rec(arr[0])
      const infoRec = rec(first?.info)
      const sid = first?.id ?? first?.sessionID ?? infoRec?.id
      if (typeof sid === "string") {
        const getFn = sessionNS.get as ((id: string) => Promise<unknown>) | undefined
        if (typeof getFn === "function") {
          const s = await getFn.call(sessionNS, sid)
          const id = providerIDFromMessages(rec(s)?.messages)
          if (id) {
            notes.push(`api.client.session.get(${sid}) 最近消息 → ${id}`)
            return { providerID: id, notes }
          }
          notes.push(`api.client.session.get(${sid}) 消息里没有 providerID（shape=${shapeOf(s)}）`)
        }
      } else {
        notes.push(`api.client.session.list() 拿不到 session id（shape=${shapeOf(list)}）`)
      }
    } else {
      notes.push(`api.client.session 无 list()，成员=[${Object.keys(sessionNS).join(",")}]`)
    }
  } catch (e) {
    notes.push(`api.client.session 抛异常: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 第 3 层：api.data.session
  try {
    const dataSession = rec(rec(a.data)?.session) ?? {}
    for (const key of Object.keys(dataSession)) {
      const v = dataSession[key]
      if (typeof v === "function" && key !== "get" && key !== "select") {
        const r = await (v as () => Promise<unknown>).call(dataSession)
        const id = pickProviderIDFromModelLike(r) ?? providerIDFromMessages(r)
        if (id) {
          notes.push(`api.data.session.${key}() → ${id}`)
          return { providerID: id, notes }
        }
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
        const id = pickProviderIDFromModelLike(m)
        if (id) ids.add(id)
      }
      notes.push(`api.client.model 列表里出现的 providerID=[${[...ids].join(",")}]（无「当前」语义，仅供对照）`)
    }
  } catch (e) {
    notes.push(`api.client.model 抛异常: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { notes }
}
