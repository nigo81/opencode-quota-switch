// 解析层出口：四个 provider 的纯函数解析器 + 少量共用的字段容错工具。
// 纯函数、零网络、零依赖；UI 层与 provider 层统一从这里取，避免直接 import 单文件实现。

export { parseGlmQuota } from "./glm.js"
export { parseKimiQuota } from "./kimi.js"
export { parseDeepSeekBalance } from "./deepseek.js"
export { parseMinimaxQuota } from "./minimax.js"

// 兼容上游 opencode-quota-usage 的 import 面（main.ts 曾从这里取 asRecord）
export { asRecord, formatReset, toNum } from "./common.js"

export type { ProviderQuota, ProviderLike, QuotaExtra, QuotaSnapshot, QuotaWindow } from "../types.js"
