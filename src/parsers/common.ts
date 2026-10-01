// 解析器公共工具：从上游 opencode-quota-usage 单文件实现拆出，供各 provider 解析器复用。
// 纯函数、零网络、零依赖（唯一 import 是 ../types.js 的类型契约）。
// 复杂度约束：单函数认知复杂度 ≤15（SonarQube S3776），嵌套三元禁止（S3358）。

import type { QuotaWindow } from "../types.js"

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** 数值容错：Kimi 返回字符串数值 */
export function toNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const t = v.trim()
    if (t === "") return undefined
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === "string" ? v : undefined
}

export function limitsOf(data: Record<string, unknown>): (Record<string, unknown> | undefined)[] {
  const raw = data.limits
  if (!Array.isArray(raw)) return []
  return raw.map(asRecord)
}

export function pctOf(used: number | undefined, limit: number | undefined): number | undefined {
  if (used == null || limit == null || limit <= 0) return undefined
  return Math.max(0, Math.min(100, (used / limit) * 100))
}

// 智谱给毫秒时间戳，Kimi 给 ISO 字符串，社区还见过秒级——统一归一到毫秒
function normalizeEpoch(n: number): number {
  if (n > 1e12) return n
  if (n > 1e9) return n * 1000
  return n
}

function stringToMs(s: string): number | undefined {
  const t = s.trim()
  if (t === "") return undefined
  const n = Number(t)
  if (Number.isFinite(n) && n > 1e9) return normalizeEpoch(n)
  const parsed = Date.parse(t)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 归一到毫秒的容错入口（数字秒/毫秒、数字字符串、ISO 字符串）。排序键与 formatReset 必须同源，
 *  否则会出现「按 A 时刻排序、却显示 B 时刻」的行序错乱。 */
export function timeToMs(v: unknown): number | undefined {
  if (typeof v === "number") return normalizeEpoch(v)
  if (typeof v === "string") return stringToMs(v)
  return undefined
}

// 侧栏行宽紧张：当日只给 HH:mm，跨天只给 MM-DD（年份无信息量，时分跨天无意义）
function formatResetLabel(d: Date): string {
  const now = new Date()
  const pad = (x: number) => String(x).padStart(2, "0")
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 重置时间容错入口：毫秒/秒时间戳、ISO 字符串、reset_at 拼写 */
export function formatReset(v: unknown): string | undefined {
  const ms = timeToMs(v)
  if (ms == null) return undefined
  return formatResetLabel(new Date(ms))
}

// 窗口展示顺序固定：5h 在上、周在下，其余殿后（Kimi 原始响应周在前，需归一）
export function windowRank(label: string): number {
  if (label === "5h") return 0
  if (label === "周") return 1
  return 2
}

export function sortByDisplayOrder(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.sort((a, b) => windowRank(a.label) - windowRank(b.label))
}
