// DeepSeek adapter：条目匹配 + 余额拉取。
// 匹配与抓取逐行等价于上游 opencode-quota-usage@0.3.7。
// DeepSeek 无 coding plan（/user/coding_plan、/coding/v1/usages、/user/usage 实测全 404），
// 只有 /user/balance 余额，所以这里只出余额、没有任何窗口。

import { getJson, hostOf, matchesAny } from "../http.js"
import { parseDeepSeekBalance } from "../parsers/deepseek.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

const isDeepSeek = (p: ProviderLike): boolean => matchesAny(p.baseURL ?? "", ["api.deepseek.com"]) || p.id === "deepseek"

async function fetchDeepSeek(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey) throw new Error("DeepSeek provider 缺少 apiKey")
  const origin = p.baseURL ? hostOf(p.baseURL) : "https://api.deepseek.com"
  const json = await getJson(`${origin}/user/balance`, { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" })
  return parseDeepSeekBalance(json)
}

export const deepseekAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  match: isDeepSeek,
  fetch: fetchDeepSeek,
} as const
