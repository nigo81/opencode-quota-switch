// Kimi adapter：条目匹配 + 配额拉取。
// 匹配与抓取逐行等价于上游 opencode-quota-usage@0.3.7。

import { getJson, matchesAny, trimSlashes } from "../http.js"
import { parseKimiQuota } from "../parsers/kimi.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

const isKimi = (p: ProviderLike): boolean =>
  matchesAny(p.baseURL ?? "", ["api.kimi.com/coding"]) ||
  matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["kimi-for-coding", "kimi", "moonshot"])

// 兜底站点：v2.0.21 宿主不暴露 api.state，从 auth.json 取凭证时拿不到 baseURL。
// 必须带 /v1：实测 https://api.kimi.com/coding/usages 是 404，/coding/v1/usages 才是 200。
const KIMI_DEFAULT_BASE = "https://api.kimi.com/coding/v1"

async function fetchKimi(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey) throw new Error("Kimi provider 缺少 apiKey")
  const base = p.baseURL ? trimSlashes(p.baseURL) : KIMI_DEFAULT_BASE
  const json = await getJson(`${base}/usages`, { Authorization: `Bearer ${p.apiKey}`, Accept: "application/json" })
  return parseKimiQuota(json)
}

export const kimiAdapter = {
  id: "kimi",
  label: "Kimi",
  match: isKimi,
  fetch: fetchKimi,
} as const
