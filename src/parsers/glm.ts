// 智谱 GLM Coding Plan：/api/monitor/usage/quota/limit
// 逻辑逐行等价于上游 opencode-quota-usage@0.3.7 的 GLM 分支，仅拆分为独立模块。

import type { ProviderQuota, QuotaWindow } from "../types.js"
import { asRecord, formatReset, limitsOf, pctOf, sortByDisplayOrder, strField, toNum } from "./common.js"

function glmWindowRow(l: Record<string, unknown> | undefined, label: string): QuotaWindow {
  const total = toNum(l?.usage)
  const used = toNum(l?.currentValue)
  return {
    label,
    usedPct: toNum(l?.percentage) ?? pctOf(used, total),
    used,
    limit: total,
    resetLabel: formatReset(l?.nextResetTime),
  }
}

// 排序后首条=5h（重置更早）、次条=周；单条视为老套餐仅 5h 额度
function glmLegacyLabel(count: number, index: number): string {
  if (count <= 1) return "额度"
  if (index === 0) return "5h"
  return "周"
}

// 新套餐实测：5h 窗口恒为 unit=3/number=5，周窗口恒为 unit=6/number=1。
// 5h 重置瞬间 nextResetTime 可能缺失，按重置时间排序会错位标签（实证事故），必须用字段直接判定
function glmCreditLabel(l: Record<string, unknown> | undefined, fallback: string): string {
  const unit = toNum(l?.unit)
  const number = toNum(l?.number)
  if (unit === 3 && number === 5) return "5h"
  if (unit != null && number != null) return "周"
  return fallback
}

function glmWindows(data: Record<string, unknown>): QuotaWindow[] {
  const rawLimits = limitsOf(data)
  const windows: QuotaWindow[] = []
  // 新套餐实测为 CREDIT_LIMIT（usage/currentValue/percentage），老套餐社区脚本按 TOKENS_LIMIT+percentage
  const tokenLike = rawLimits.filter((l) => l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT")
  const sorted = [...tokenLike].sort(
    (a, b) => (toNum(a?.nextResetTime) ?? Number.MAX_SAFE_INTEGER) - (toNum(b?.nextResetTime) ?? Number.MAX_SAFE_INTEGER),
  )
  sorted.forEach((l, i) => {
    windows.push(glmWindowRow(l, glmCreditLabel(l, glmLegacyLabel(sorted.length, i))))
  })
  const mcp = rawLimits.find((l) => l?.type === "TIME_LIMIT")
  if (mcp) windows.push(glmWindowRow(mcp, "MCP"))
  return sortByDisplayOrder(windows)
}

/** 智谱 GLM Coding Plan /api/monitor/usage/quota/limit */
export function parseGlmQuota(json: unknown): ProviderQuota {
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  if (root.success === false) throw new Error(strField(root, "msg") ?? "接口返回失败")
  const data = asRecord(root.data) ?? root
  const windows = glmWindows(data)
  if (!windows.length) throw new Error("响应中无 TOKENS_LIMIT/CREDIT_LIMIT 窗口")
  return { level: strField(data, "level"), windows, extras: [] }
}
