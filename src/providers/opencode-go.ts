// OpenCode Go adapter：条目匹配 + 配额拉取。
// 站点固定，不从 baseURL 推导——见 GO_USAGE_URL 的注释。

import { getJsonRaw, matchesAny } from "../http.js"
import { asRecord, strField } from "../parsers/common.js"
import { parseOpenCodeGoQuota } from "../parsers/opencode-go.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

/**
 * 只认 "opencode-go"，绝不能退化成裸 "opencode"：宿主 providerID 里还有 opencode-zen 等
 * 其它 opencode 官方 provider，裸匹配会把它们也吞掉，面板串台。
 * baseURL 侧用 "zen/go" 这类路径特征，不用 host 特征。
 */
const isOpenCodeGo = (p: ProviderLike): boolean =>
  matchesAny(p.baseURL ?? "", ["zen/go"]) ||
  matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["opencode-go"])

// 固定站点：配额接口只在这一条路径下提供，baseURL 通常是推理端点（hostOf 拼出的 origin 不带 /zen/go 前缀）。
// v2.0.21 宿主不暴露 api.state、从 auth.json 取 key 时更是完全拿不到 baseURL。
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

/** 403 必须读 body 才知道是没订阅还是别的拒绝；body 可能是对象也可能是纯文本 */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body
  try {
    return JSON.stringify(body) ?? ""
  } catch {
    return ""
  }
}

// 实测（坏 key）：HTTP 401 {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}
// 200 + 错误体是防御性分支：成功路径未实测，不能假设 200 就一定是配额数据。
function errorMessageOf(body: unknown): string | undefined {
  const root = asRecord(body)
  if (!root || root.type !== "error") return undefined
  return strField(asRecord(root.error), "message") ?? "OpenCode Go 接口返回错误"
}

// 403 + EntitlementError = 有 key 但没订阅 OpenCode Go（来自竞品实现，未实测验证）；
// 消息里绝不回显 apiKey。
function deniedMessage(body: unknown): string {
  if (bodyText(body).includes("EntitlementError")) return "OpenCode Go 未订阅"
  return "OpenCode Go 访问被拒（HTTP 403）"
}

async function fetchOpenCodeGo(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey) throw new Error("OpenCode Go provider 缺少 apiKey")
  // ⚠️ 禁止用 https://opencode.ai/zen/go/v1/models 做连通性测试或兜底：它不校验鉴权，
  // 无效 key 也返回 200，探测会误判为「可用」。
  const { status, body } = await getJsonRaw(GO_USAGE_URL, {
    Authorization: `Bearer ${p.apiKey}`,
    Accept: "application/json",
  })
  if (status === 200) {
    const message = errorMessageOf(body)
    if (message != null) throw new Error(message)
    // usage 存在与否交给 parser 判：成功形状未实测，parser 里的防御分支报错比这里硬猜更准
    return parseOpenCodeGoQuota(body)
  }
  if (status === 401) throw new Error("OpenCode Go 鉴权失败（检查 auth.json 里的 key）")
  if (status === 403) throw new Error(deniedMessage(body))
  throw new Error(`HTTP ${status}`)
}

export const openCodeGoAdapter = {
  id: "opencode-go",
  label: "OpenCode Go",
  match: isOpenCodeGo,
  fetch: fetchOpenCodeGo,
} as const
