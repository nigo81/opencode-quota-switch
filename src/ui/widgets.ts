/**
 * 排版原语：CJK 宽度换算、截断、进度条。
 *
 * 全部从 opencode-glm-vistatus@1.5.0 的 dist/tui.js 原样搬过来
 * （`src/ui/widgets.ts` 模块段，bundle L371-425），逐字未改。
 * 侧栏只有 20-40 列，标签/数值全是中文，String.padEnd 在这里完全不能用：
 * "周配额" 是 6 列、"MCP" 是 3 列，padEnd 按码点数补齐会错位。
 */

/** 单个码点的终端列宽。CJK 统一表意区、全角区、emoji 一律 2 列。 */
export function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 32) return 0
  if (code < 127) return 1
  if (code < 160) return 0
  if (
    (code >= 4352 && code <= 4447) || // Hangul Jamo
    (code >= 11904 && code <= 42191) || // CJK Radicals … Yi
    (code >= 44032 && code <= 55203) || // Hangul
    (code >= 63744 && code <= 64255) || // CJK Compat
    (code >= 65040 && code <= 65135) || // Vertical / Compat
    (code >= 65281 && code <= 65376) || // Fullwidth
    (code >= 65504 && code <= 65510) || // Fullwidth signs
    (code >= 127744 && code <= 128591) || // Misc Symbols (emoji)
    (code >= 131072 && code <= 262141)
  )
    return 2
  return 1
}

/** 字符串占用的终端列数。 */
export function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

/** 按显示宽度截断，超长时以省略号收尾（不切开半个宽字符）。 */
export function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  let result = ""
  let w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) {
      result += "…"
      break
    }
    result += c
    w += cw
  }
  return result
}

/**
 * 半格精度的进度条。实心格 `█`(U+2588)，1/3~2/3 用 `▒`(U+2592)，
 * 2/3 以上用 `▓`(U+2593)，空轨道用 `░`(U+2591)——空轨道刻意选了比
 * 过渡格更浅的字符，空槽才不会和"有一点点用量"混淆。
 */
export function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const exactFilled = (clamped / 100) * width
  const filled = Math.floor(exactFilled)
  if (filled >= width) {
    return "█".repeat(width)
  }
  const fraction = exactFilled - filled
  let transition = ""
  let empty = Math.max(0, width - filled)
  if (fraction >= 2 / 3) {
    transition = "▓"
    empty -= 1
  } else if (fraction >= 1 / 3) {
    transition = "▒"
    empty -= 1
  }
  return "█".repeat(filled) + transition + "░".repeat(empty)
}

// ---------------------------------------------------------------------------
// 条形图几何常量（bundle L709-713，逐字照搬）
// ---------------------------------------------------------------------------

/** 侧栏再窄也要保住这么多列，否则条形图没有意义 */
export const MIN_PANEL_WIDTH = 20
/** 首帧还没有实测宽度时的乐观估计 */
export const DEFAULT_PANEL_WIDTH = 30
/** `[` 与 `]` 合计占掉的列 */
export const BAR_BRACKETS = 2
/** 条尾与百分比之间至少留的空格 */
export const BAR_GAP = 1
/** 百分比列的右对齐宽度：` 28%` / `  7%` / `100%` */
export const PCT_WIDTH = 4
/** 折叠三角 + 空格 */
export const HEADER_PREFIX = 2
