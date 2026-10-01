// 智谱 GLM adapter：条目匹配 + 配额拉取。
// 匹配与抓取逐行等价于上游 opencode-quota-usage@0.3.7。

import { getJson, hostOf, matchesAny } from "../http.js"
import { parseGlmQuota } from "../parsers/glm.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

const isGlm = (p: ProviderLike): boolean =>
  matchesAny(p.baseURL ?? "", ["open.bigmodel.cn", "api.z.ai"]) ||
  matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["zhipu", "bigmodel", "z.ai"])

// 用户配置里同时存在 coding 端点与 paas 端点的智谱 provider，套餐额度必须用 coding 那个的 key
const isGlmCoding = (p: ProviderLike): boolean => (p.baseURL ?? "").includes("/coding/")

async function fetchGlm(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey || !p.baseURL) throw new Error("GLM provider 缺少 apiKey/baseURL")
  const json = await getJson(`${hostOf(p.baseURL)}/api/monitor/usage/quota/limit`, {
    Authorization: p.apiKey, // 实测：智谱监控接口为裸 key，不带 Bearer 前缀
    "Content-Type": "application/json",
    "Accept-Language": "en-US,en",
  })
  return parseGlmQuota(json)
}

export const glmAdapter = {
  id: "glm",
  label: "GLM",
  match: isGlm,
  prefer: isGlmCoding,
  fetch: fetchGlm,
} as const
