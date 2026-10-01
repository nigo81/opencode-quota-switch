// MiniMax adapter：条目匹配 + token plan 配额拉取（本仓库新增的 provider）。
//
// 端点：GET https://api.minimaxi.com/v1/token_plan/remains
//       Authorization: Bearer <key>   Accept: application/json
// 官方文档：https://platform.minimaxi.com/docs/token-plan/faq
//
// 不要改用旧的 https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains：
// 它已改为 cookie 门禁，带合法 API key 也只回 status_code 1004 "cookie is missing"。

import { getJson, hostOf, matchesAny } from "../http.js"
import { parseMinimaxQuota } from "../parsers/minimax.js"
import type { ProviderLike, ProviderQuota } from "../types.js"

const MINIMAX_HOSTS = ["api.minimaxi.com", "www.minimaxi.com", "api.minimax.io", "api.minimax.cn"]

const isMinimax = (p: ProviderLike): boolean =>
  matchesAny(p.baseURL ?? "", MINIMAX_HOSTS) ||
  // 用户真实 provider id 形如 minimax-cn-coding-plan，只看 id/name 也要能命中
  matchesAny(`${p.id ?? ""} ${p.name ?? ""}`, ["minimax"])

// host 未配置时退回官方主站（token_plan 在站点根路径，不带 /v1 前缀差异）
const MINIMAX_DEFAULT_ORIGIN = "https://api.minimaxi.com"

async function fetchMinimax(p: ProviderLike): Promise<ProviderQuota> {
  if (!p.apiKey) throw new Error("MiniMax provider 缺少 apiKey")
  const origin = p.baseURL ? hostOf(p.baseURL) : MINIMAX_DEFAULT_ORIGIN
  const json = await getJson(`${origin}/v1/token_plan/remains`, {
    Authorization: `Bearer ${p.apiKey}`,
    Accept: "application/json",
  })
  return parseMinimaxQuota(json)
}

export const minimaxAdapter = {
  id: "minimax",
  label: "MiniMax",
  match: isMinimax,
  fetch: fetchMinimax,
} as const
