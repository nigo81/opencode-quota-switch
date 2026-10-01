// Kimi adapter：条目匹配 + 配额拉取。
// 匹配与抓取逐行等价于上游 opencode-quota-usage@0.3.7。

import { getJson, matchesAny, trimSlashes } from "../http.js"
import { parseKimiQuota } from "../parsers/kimi.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

const isKimi = (p: ProviderLike): boolean => matchesAny(p.baseURL ?? "", ["api.kimi.com/coding"]) || p.id === "kimi"

async function fetchKimi(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey || !p.baseURL) throw new Error("Kimi provider 缺少 apiKey/baseURL")
  const base = trimSlashes(p.baseURL)
  const json = await getJson(`${base}/usages`, { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" })
  return parseKimiQuota(json)
}

export const kimiAdapter = {
  id: "kimi",
  label: "Kimi",
  match: isKimi,
  fetch: fetchKimi,
} as const
