// OpenCode Go：GET https://opencode.ai/zen/go/v1/usage（Bearer key）
//
// 响应形状（成功路径未实测——本机无 opencode-go 订阅/key，字段名取自竞品实现 + 端点存在性验证）：
//   {"usage":{"rolling":{"status":"ok","percent":23,"resetsAt":"2026-10-01T12:00:00+08:00"},
//             "weekly":{...},"monthly":{...}}}
//
// ★★★ 本接口的 percent 是「已用」0-100，不是剩余——与 MiniMax 的 *_remaining_percent 语义相反
// （见 parsers/minimax.ts 陷阱 1）。照抄那边的 `100 - percent` 会把进度条画反。
//
// 第二个坑：status="rate-limited" 表示 0% 剩余 = 已用 100%，此时 percent 可能仍是旧值甚至缺失，
// 必须让 status 优先于 percent，否则限流后反而显示剩余额度。

import type { ProviderQuota, QuotaWindow } from "../types.js"
import { asRecord, formatReset, sortByDisplayOrder, toNum } from "./common.js"

type Entry = Record<string, unknown>

// 三个窗口是固定键名而非数组：rolling=5 小时滚动窗口，weekly=周，monthly=月。
// 展示顺序交给 sortByDisplayOrder（common.ts 的 windowRank：5h→0 / 周→1 / 其余→2，月自动殿后）。
const WINDOW_LABELS: Record<string, string> = { rolling: "5h", weekly: "周", monthly: "月" }

function isRateLimited(entry: Entry): boolean {
  return entry.status === "rate-limited"
}

function clampPercent(pct: number | undefined): number | undefined {
  if (pct == null) return undefined
  return Math.max(0, Math.min(100, pct))
}

/** 本接口只给百分比，不给 used/limit（也不该反推），面板退化为纯百分比行 */
function goWindow(entry: Entry, label: string): QuotaWindow {
  const usedPct = isRateLimited(entry) ? 100 : clampPercent(toNum(entry.percent))
  // resetsAt 是带 +08:00 偏移的 ISO 字符串，formatReset 已归一（当天给 HH:mm，跨天给 MM-DD）
  return { label, usedPct, resetLabel: formatReset(entry.resetsAt) }
}

function goWindows(usage: Entry): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const [key, label] of Object.entries(WINDOW_LABELS)) {
    const entry = asRecord(usage[key])
    if (entry) windows.push(goWindow(entry, label))
  }
  return windows
}

/** OpenCode Go /zen/go/v1/usage：usage.rolling/weekly/monthly 三个窗口 */
export function parseOpenCodeGoQuota(json: unknown): ProviderQuota {
  // 防御：成功响应形状未实测，形状对不上时这里给出可读报错，而不是让面板崩在下游
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  const usage = asRecord(root.usage)
  if (!usage) throw new Error("响应中无 usage 字段")
  const windows = goWindows(usage)
  if (!windows.length) throw new Error("响应中无 rolling/weekly/monthly 窗口")
  // 本接口没有套餐等级字段，level 留空；也没有余额/账单类字段，extras 为空
  return { windows: sortByDisplayOrder(windows), extras: [] }
}
