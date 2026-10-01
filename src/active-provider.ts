/**
 * 活跃 provider 判定：从当前会话的消息里反推「用户正在用哪个 provider」。
 *
 * 刻意做成零依赖纯函数（不 import solid-js、不 import SDK 类型）：
 * 消息按 role 逐字段收窄，契约是运行时收窄而非类型断言——
 * 这样判定逻辑可以脱离 TUI 宿主离线验证。
 *
 * 优先级：会话内最近一条消息 > 全局配置默认模型。
 * 新会话尚无消息时回落到配置默认值。
 */

/** 取对象视图，非对象（含数组/null）一律 undefined */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === "string" && v !== "" ? v : undefined
}

/**
 * 从消息列表倒序找最近一条带 providerID 的消息。
 *
 * 两条判别路径：
 * - role=assistant → 顶层 `providerID`（必填）
 * - role=user      → `model.providerID`（可选，用户可能没记模型）
 *
 * 倒序遍历：时间正序遍历会在新消息尚未落库时返回旧 provider，产生闪跳。
 */
export function providerIdFromMessages(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = asRecord(messages[i])
    if (!msg) continue
    const role = strField(msg, "role")
    if (role === "assistant") {
      const direct = strField(msg, "providerID")
      if (direct) return direct
      continue
    }
    if (role === "user") {
      const nested = strField(asRecord(msg.model), "providerID")
      if (nested) return nested
    }
  }
  return undefined
}

/**
 * 从配置默认模型取 providerID。
 * `config.model` 形如 "minimax-cn-coding-plan/MiniMax-M3.1-Flash-Preview"，
 * 取斜杠前段即 providerID。`small_model` 作为次选（摘要用的小模型通常同 provider，
 * 但配置里可能只填了 small_model）。
 */
export function providerIdFromConfig(config: unknown): string | undefined {
  const rec = asRecord(config)
  if (!rec) return undefined
  for (const key of ["model", "small_model"] as const) {
    const raw = strField(rec, key)
    if (!raw) continue
    const head = raw.split("/")[0]?.trim()
    if (head) return head
  }
  return undefined
}

export type ActiveProvider = {
  providerID: string | undefined
  /** 判定来源，用于排查「为什么显示了别的 provider」 */
  source: "message" | "config" | "none"
}

export function resolveActiveProvider(input: {
  messages: readonly unknown[]
  config: unknown
}): ActiveProvider {
  const fromMessage = providerIdFromMessages(input.messages)
  if (fromMessage) return { providerID: fromMessage, source: "message" }
  const fromConfig = providerIdFromConfig(input.config)
  if (fromConfig) return { providerID: fromConfig, source: "config" }
  return { providerID: undefined, source: "none" }
}
