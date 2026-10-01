// Kimi Code：/coding/v1/usages（usage=周限额，limits[].window 300 MINUTE=5h 窗口）
// 逻辑逐行等价于上游 opencode-quota-usage@0.3.7 的 Kimi 分支，仅拆分为独立模块。

import type { ProviderQuota, QuotaExtra, QuotaWindow } from "../types.js"
import { asRecord, formatReset, limitsOf, pctOf, sortByDisplayOrder, strField, toNum } from "./common.js"

function kimiWindowLabel(win: Record<string, unknown> | undefined): string {
  const dur = toNum(win?.duration)
  const unit = strField(win, "timeUnit") ?? ""
  if (unit.includes("MINUTE") && dur === 300) return "5h"
  if (dur == null) return "窗口"
  if (unit.includes("MINUTE")) return `${dur}m`
  if (unit.includes("HOUR")) return `${dur}h`
  if (unit.includes("DAY")) return `${dur}d`
  return `${dur}`
}

// Kimi 双拼写：used 直给，或 remaining 反推
function kimiUsed(detail: Record<string, unknown> | undefined, limit: number | undefined): number | undefined {
  const used = toNum(detail?.used)
  if (used != null) return used
  const remaining = toNum(detail?.remaining)
  if (remaining != null && limit != null) return limit - remaining
  return undefined
}

function kimiWindows(root: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  const usage = asRecord(root.usage)
  if (usage) {
    const limit = toNum(usage.limit)
    // 周窗口重置前后字段会切换：满额时给 used，清零后给 remaining（实证 2026-09-14 重置）
    const used = kimiUsed(usage, limit)
    windows.push({
      label: "周",
      usedPct: pctOf(used, limit),
      used,
      limit,
      resetLabel: formatReset(usage.resetTime ?? usage.reset_at),
    })
  }
  for (const item of limitsOf(root)) {
    const detail = asRecord(item?.detail) ?? item
    const limit = toNum(detail?.limit)
    const used = kimiUsed(detail, limit)
    windows.push({
      label: kimiWindowLabel(asRecord(item?.window)),
      usedPct: pctOf(used, limit),
      used,
      limit,
      resetLabel: formatReset(detail?.resetTime ?? detail?.reset_at),
    })
  }
  return windows
}

function kimiExtras(root: Record<string, unknown>): QuotaExtra[] {
  const cents = toNum(asRecord(asRecord(root.boosterWallet)?.monthlyUsed)?.priceInCents)
  if (cents == null) return []
  return [{ label: "月消", value: `¥${(cents / 100).toFixed(2)}` }]
}

function stripLevelPrefix(level: string | undefined): string | undefined {
  if (level == null) return undefined
  return level.startsWith("LEVEL_") ? level.slice("LEVEL_".length) : level
}

/** Kimi Code /coding/v1/usages：usage=周限额，limits[].window 300 MINUTE=5h 窗口 */
export function parseKimiQuota(json: unknown): ProviderQuota {
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  const windows = kimiWindows(root)
  if (!windows.length) throw new Error("响应中无 usage/limits 窗口")
  sortByDisplayOrder(windows)
  const level = strField(asRecord(asRecord(root.user)?.membership), "level")
  return { level: stripLevelPrefix(level), windows, extras: kimiExtras(root) }
}
