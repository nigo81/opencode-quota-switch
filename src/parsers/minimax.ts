// MiniMax token plan：GET /v1/token_plan/remains（Bearer key）
// 官方文档：https://platform.minimaxi.com/docs/token-plan/faq
//
// 三个已验证的字段陷阱（2026-10 实测，照抄上游 opencode 插件的踩坑结论）：
//
// 1. *_usage_count 在本接口返回的是「剩余」不是「已用」（旧的 coding_plan/remains 端点才是已用）。
//    直接把它当 used 会得到完全颠倒的数字。本解析器只信 *_remaining_percent，usedPct = 100 - remaining。
// 2. *_status === 3 表示「该窗口不适用于你当前的套餐层级」（实测 weekly_status:3 且 remaining=100%，
//    属于典型的"没买周包"）。必须整行省略，否则会渲染出一条恒 0% 的假周窗口。
// 3. 老套餐上 *_total_count 恒为 0，不能据此反推 used/limit（0 既可能是"无限量"也可能是"没数据"）。
//    因此本解析器一律不产出 used/limit，面板退化为纯百分比行——这与 GLM 缺 percentage 时的
//    TOKENS_LIMIT 兜底形态一致，UI 契约已覆盖（见 types.ts 的 QuotaWindow.usedPct 可选）。
//
// 端点选择：必须用 /v1/token_plan/remains。旧的
// https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains 现已 cookie 门禁，
// 即使带合法 API key 也返回 status_code 1004 "cookie is missing"。

import type { ProviderQuota, QuotaWindow } from "../types.js"
import { asRecord, formatReset, sortByDisplayOrder, strField, toNum } from "./common.js"

type Entry = Record<string, unknown>

/** 入口选择：model_remains 混装多模态条目，MiniMax-M* 优先，其次 general，再退 chat/text。只取一条。 */
function pickEntry(entries: Entry[]): Entry | undefined {
  const byName = (pred: (name: string) => boolean): Entry | undefined =>
    entries.find((e) => pred(strField(e, "model_name") ?? ""))
  return (
    byName((n) => /^minimax-m/i.test(n)) ??
    byName((n) => n === "general") ??
    byName((n) => n === "chat" || n === "text")
  )
}

/**
 * 构造单个额度窗口。prefix 决定读哪组 current_<prefix>_* 字段（interval / weekly），
 * 避免两个窗口复制两份字段名——字段名拼错是本接口最容易踩的坑。
 * 返回 undefined 表示该窗口不适用于当前套餐（status=3），调用方直接丢弃。
 */
function minmaxWindow(entry: Entry, prefix: "interval" | "weekly", label: string): QuotaWindow | undefined {
  // 陷阱 2：status=3 = 该窗口不适用于你的套餐层级，整行省略
  if (toNum(entry[`current_${prefix}_status`]) === 3) return undefined
  const remaining = toNum(entry[`current_${prefix}_remaining_percent`])
  // 陷阱 1：只用 remaining_percent（无歧义），*_usage_count 是「剩余」不是「已用」，绝不能当 used
  const usedPct = remaining == null ? undefined : Math.max(0, Math.min(100, 100 - remaining))
  return {
    label,
    usedPct,
    // 陷阱 3：老套餐 total 恒为 0，used/limit 一律留空，交由 UI 渲染纯百分比行
    resetLabel: formatReset(prefix === "interval" ? entry.end_time : entry.weekly_end_time),
  }
}

/**
 * 该接口不返回套餐等级字段。选中具体 MiniMax-M* 模型时把它当 level 展示（用户能确认取的是哪条额度），
 * 退到 general/chat/text 时无信息量，不显示。
 */
function minmaxLevel(entry: Entry): string | undefined {
  const name = strField(entry, "model_name")
  if (name == null || !/^minimax-m/i.test(name)) return undefined
  return name
}

/** MiniMax /v1/token_plan/remains：model_remains[] 里挑一条，出 5h / 周 两个窗口 */
export function parseMinimaxQuota(json: unknown): ProviderQuota {
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  const baseResp = asRecord(root.base_resp)
  const code = toNum(baseResp?.status_code)
  if (code != null && code !== 0) {
    throw new Error(strField(baseResp, "status_msg") ?? `接口返回失败（status_code=${code}）`)
  }
  const raw = root.model_remains
  const entries = Array.isArray(raw) ? raw.map(asRecord).filter((e): e is Entry => e != null) : []
  const entry = pickEntry(entries)
  if (!entry) throw new Error("响应中无可用额度条目（model_remains 为空或 model_name 不可识别）")
  const windows = [
    minmaxWindow(entry, "interval", "5h"),
    minmaxWindow(entry, "weekly", "周"),
  ].filter((w): w is QuotaWindow => w != null)
  if (!windows.length) throw new Error("额度条目的 5h/周窗口均为 status=3，不适用于当前套餐")
  return { level: minmaxLevel(entry), windows: sortByDisplayOrder(windows), extras: [] }
}
