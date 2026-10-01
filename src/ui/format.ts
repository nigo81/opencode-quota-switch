/**
 * 数值格式化。
 *
 * formatNumber / formatPercentage / DAY_NAMES / formatClockShort 是从
 * opencode-glm-vistatus@1.5.0 的 dist/tui.js（`src/utils/format.ts` 模块段，
 * bundle L325-334、L335、L364-368）原样搬过来的。
 *
 * formatResetCountdown / formatResetClock（L336-363）只改了一件事：
 * 把函数体里的 `Date.now()` 换成显式的 `now` 形参。参考实现把这两个结果
 * 当成 frozen const 在渲染时算一次就塞进节点（L841-842），倒计时要等到下一
 * 轮几分钟一次的数据刷新才会跳。这里把"现在几点"交给调用方的 now 信号，
 * 每秒重算一次。
 */

export function formatNumber(n: number): string {
  // 唯一的偏离：参考实现直接 toLocaleString，非有限数会漏出 "NaN"。
  if (!Number.isFinite(n)) return "—"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K"
  return n.toLocaleString("en-US")
}

export function formatPercentage(n: number): string {
  const rounded = Math.floor(n * 10) / 10
  if (Number.isInteger(rounded)) return rounded + "%"
  return rounded.toFixed(1) + "%"
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** 距重置还有多久：`2h 30m` / `4d 1h`，无重置时间时 `—`。 */
export function formatResetCountdown(resetTime: number | null, now: number = Date.now()): string {
  if (resetTime === null) return "—"
  const diffMs = resetTime - now
  if (diffMs <= 0) return "—"
  const totalMinutes = Math.floor(diffMs / (1000 * 60))
  if (totalMinutes >= 24 * 60) {
    const totalHours = Math.floor(totalMinutes / 60)
    const days = Math.floor(totalHours / 24)
    const hours2 = totalHours % 24
    return `${days}d ${hours2}h`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${minutes}m`
}

/** 重置的钟点；超过 24h 带上星期，`16:58` / `Thu 16:03`。 */
export function formatResetClock(resetTime: number | null, now: number = Date.now()): string {
  if (resetTime === null) return ""
  const diffMs = resetTime - now
  if (diffMs <= 0) return ""
  const totalMinutes = Math.floor(diffMs / (1000 * 60))
  const resetDate = new Date(resetTime)
  const hh = String(resetDate.getHours()).padStart(2, "0")
  const mm = String(resetDate.getMinutes()).padStart(2, "0")
  if (totalMinutes >= 24 * 60) {
    return `${DAY_NAMES[resetDate.getDay()]} ${hh}:${mm}`
  }
  return `${hh}:${mm}`
}

export function formatClockShort(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${hh}:${mm}`
}

/** 契约里的窗口只有 `resetLabel`（"HH:mm" / "MM-DD"），没有 epoch 时间戳。 */
export type ResolvedReset = {
  /** 解析出的重置时刻（epoch ms），已按"下一次发生"向前滚动 */
  at: number
  /** 是否解析出了具体钟点；false 时只有日期，调用方应回显原始标签而不是编一个钟点 */
  hasClock: boolean
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/
const DATE_RE = /^(\d{1,2})-(\d{1,2})$/
const DATE_TIME_RE = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/

/**
 * 把 `QuotaWindow.resetLabel` 还原成一个可以算倒计时的绝对时刻。
 *
 * 冻结的 src/types.ts 只给了 `resetLabel?: string`，注释写明两种形态：
 * `"HH:mm"`（当天）与 `"MM-DD"`（跨天）。参考插件拿的是 provider 直接给的
 * `nextResetTime` epoch，所以它能同时显示 `4d 1h` 和精确的 `Thu 16:03`；
 * 这里只能从墙钟时间反推：
 *
 * - `HH:mm` → 今天该时刻，已经过了就顺延到明天（5h/周窗口的重置都是"下一个
 *   整点"，顺延一天不会错）
 * - `MM-DD HH:mm` → 精确到分钟
 * - `MM-DD` → 当年该日 00:00，已过则顺延一年；`hasClock=false`，
 *   调用方应把原始 "MM-DD" 原样回显，而不是拿午夜 00:00 冒充真实重置钟点
 *
 * 解析不了就返回 null，面板降级为只显示原始标签。相对参考实现，
 * "MM-DD" 那条线的钟点精度有损失（显示日期而非星期+时刻），这是契约的
 * 信息上限，不是实现偷懒。
 */
export function resolveResetAt(resetLabel: string | undefined, now: number): ResolvedReset | null {
  if (!resetLabel) return null
  const label = resetLabel.trim()

  const dateTime = DATE_TIME_RE.exec(label)
  if (dateTime) {
    const at = buildLocal(now, +dateTime[1], +dateTime[2], +dateTime[3], +dateTime[4])
    if (at !== null && at > now) return { at, hasClock: true }
  }

  const time = TIME_RE.exec(label)
  if (time) {
    const at = buildLocal(now, nowMonth(now), nowDay(now), +time[1], +time[2])
    if (at !== null && at <= now) {
      const next = new Date(at)
      next.setDate(next.getDate() + 1)
      return { at: next.getTime(), hasClock: true }
    }
    if (at !== null) return { at, hasClock: true }
  }

  const date = DATE_RE.exec(label)
  if (date) {
    let at = buildLocal(now, +date[1], +date[2], 0, 0)
    if (at === null) return null
    // 跨年窗口：解析出的日期已过就往后推一年
    if (at <= now) at = new Date(new Date(at).setFullYear(new Date(at).getFullYear() + 1)).getTime()
    return { at, hasClock: false }
  }

  return null
}

function nowMonth(now: number): number {
  return new Date(now).getMonth() + 1
}

function nowDay(now: number): number {
  return new Date(now).getDate()
}

/** 构造本地时区的 YYYY-MM-DD HH:mm，越界（13 月 40 日）返回 null。 */
function buildLocal(now: number, month: number, day: number, hour: number, minute: number): number | null {
  if (month < 1 || month > 12) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  const base = new Date(now)
  const d = new Date(base.getFullYear(), month - 1, day, hour, minute, 0, 0)
  if (d.getMonth() !== month - 1) return null
  if (d.getDate() !== day) return null
  return d.getTime()
}
