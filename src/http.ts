// 配额查询的网络层：唯一的 fetch 出口 + provider 条目挑选工具。
// 端口自上游 opencode-quota-usage@0.3.7 的 main.ts（getJson / hostOf / trimSlashes /
// matchesAny / pickProvider），逐行保持等价。
// 凭证只从宿主 provider 列表取（ProviderLike.apiKey），绝不读 auth.json，绝不落盘或打日志。

import type { ProviderLike } from "./types.js"

export function matchesAny(haystack: string, needles: string[]): boolean {
  const s = haystack.toLowerCase()
  return needles.some((n) => s.includes(n))
}

/** 监控接口与推理端点不同源：配额查询走站点根路径 */
export function hostOf(baseURL: string): string {
  try {
    const u = new URL(baseURL)
    return `${u.protocol}//${u.host}`
  } catch {
    return baseURL.toLowerCase().split("/api/")[0] ?? baseURL
  }
}

export function trimSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === "/") end -= 1
  return s.slice(0, end)
}

/** 多个 provider 条目命中同一 adapter 时用 prefer 做决胜（打分函数），否则取第一个 */
export function pickProvider(
  list: readonly ProviderLike[],
  match: (p: ProviderLike) => boolean,
  prefer?: (p: ProviderLike) => boolean,
): ProviderLike | undefined {
  const hit = list.filter(match)
  if (!hit.length) return undefined
  const preferred = prefer ? hit.find(prefer) : undefined
  return preferred ?? hit[0]
}

// 无超时的 fetch 在代理/网络异常时会永久挂起，卡片会永远停在"获取中"（实证事故），8 秒兜底
const REQUEST_TIMEOUT_MS = 8000

export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`响应不是 JSON：${text.slice(0, 120)}`)
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s），检查网络或代理`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}
