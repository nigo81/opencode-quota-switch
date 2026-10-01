/**
 * 配色：把宿主的 `TuiThemeCurrent` 压成面板用的九色 Morandi 调色板。
 *
 * 照搬 opencode-glm-vistatus@1.5.0 的 `src/ui/theme.ts`（bundle L428-519）：
 * rgb / saturation / desaturateTo / dimColor / FALLBACK / MAX_SAT /
 * buildPalette / quotaColor 全部逐字未改，只有类型标注是补的。
 *
 * ── 已知 bug 修复 #2：不再继承那两个硬编码色 ──────────────────────────
 * 参考插件的 v2 路径走 `mapTheme()`（bundle L1888-1898），只映射了
 * primary / text / textMuted / success / warning / error / border 七项，
 * `accent` 与 `info` 压根没产出，于是静默回落到硬编码的 `#C9A0DC` / `#8DA9B8`
 * —— 标签/数值的两色区分在这两个槽位上根本不是主题色。
 * 本实现直接吃 `TuiThemeCurrent`（宿主九个槽位全都有：primary / secondary /
 * accent / error / warning / success / info / text / textMuted / border），
 * 一次取全九项；万一某项缺失，也先从调色板内**其它槽位**推导，最后才用
 * FALLBACK 兜底。accent 走 primary、info 走 secondary/textMuted，
 * 代码路径上不再存在"accent 一定是那个紫色"的假设。
 */

import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

export type ThemeColors = {
  primary: string
  text: string
  muted: string
  accent: string
  info: string
  success: string
  warning: string
  error: string
  border: string
}

type Rgb = { r: number; g: number; b: number }

/** 接受 `#rrggbb` 或 `{r,g,b}`（opentui 的 RGBA 实例就是后者，0-1 浮点会被放大到 0-255）。 */
export function rgb(raw: unknown): Rgb | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as { r?: unknown; g?: unknown; b?: unknown }
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale),
      }
    }
  }
  return null
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const delta = max - min
  if (delta === 0) return 0
  const L = (max + min) / 2
  return L <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

/** 把颜色往灰里拉（二分求刚好不超过 maxSat 的混合比），落回 #rrggbb。 */
export function desaturateTo(raw: unknown, maxSat: number, fallback: string | null): string | null {
  const c = rgb(raw)
  if (!c) return fallback
  const sat = saturation(c.r, c.g, c.b)
  if (sat <= maxSat) {
    return "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
  }
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114
  let lo = 0
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    const nr2 = Math.round(c.r + (luma - c.r) * mid)
    const ng2 = Math.round(c.g + (luma - c.g) * mid)
    const nb2 = Math.round(c.b + (luma - c.b) * mid)
    if (saturation(nr2, ng2, nb2) > maxSat) lo = mid
    else hi = mid
  }
  const nr = Math.round(c.r + (luma - c.r) * hi)
  const ng = Math.round(c.g + (luma - c.g) * hi)
  const nb = Math.round(c.b + (luma - c.b) * hi)
  return (
    "#" +
    [nr, ng, nb]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
      .join("")
  )
}

/** 按比例压暗，用于次要信息（版本号、括号里的钟点）。 */
export function dimColor(hex: string, factor = 0.5): string {
  const c = rgb(hex)
  if (!c) return hex
  const r = Math.round(c.r * factor)
  const g = Math.round(c.g * factor)
  const b = Math.round(c.b * factor)
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
      .join("")
  )
}

/** 宿主主题还没就绪 / 色值解析不出来时的最后一档兜底。 */
export const FALLBACK: ThemeColors = {
  primary: "#8B9DAF",
  text: "#C5C5BB",
  muted: "#7A7A72",
  accent: "#C9A0DC",
  info: "#8DA9B8",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error: "#B08A8A",
  border: "#6B6B63",
}

/** Morandi 的关键：所有色相的饱和度压到 0.28 以下，终端底色上不刺眼。 */
export const MAX_SAT = 0.28

/** 宿主主题槽位 → 面板槽位。accent/info 缺失时从同一张调色板内部推导。 */
const SOURCES = {
  primary: "primary",
  text: "text",
  muted: "textMuted",
  accent: "accent",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
  border: "border",
} as const satisfies Record<keyof ThemeColors, keyof TuiThemeCurrent>

/**
 * 主题未就绪（`TuiTheme.ready === false`，或 `current` 还是空的）时传
 * undefined/null 进来，全套走 FALLBACK，面板不会崩。
 */
export function buildPalette(theme: TuiThemeCurrent | null | undefined): ThemeColors {
  const pick = (slot: keyof ThemeColors): string | null =>
    desaturateTo(theme?.[SOURCES[slot]], MAX_SAT, null)

  const primary = pick("primary")
  const text = pick("text")
  const muted = pick("muted")
  const success = pick("success")
  const warning = pick("warning")
  const error = pick("error")
  // border 缺失时退到更淡的 borderSubtle（宿主主题里也有），再退到 muted
  const border = pick("border") ?? desaturateTo(theme?.borderSubtle, MAX_SAT, null) ?? muted
  // 这两项旧版是硬编码的，现在一律来自主题；主题自己没给才从兄弟槽位推导。
  const secondary = desaturateTo(theme?.secondary, MAX_SAT, null)
  const accent = pick("accent") ?? primary ?? text
  const info = pick("info") ?? secondary ?? muted ?? text

  return {
    primary: primary ?? FALLBACK.primary,
    text: text ?? FALLBACK.text,
    muted: muted ?? FALLBACK.muted,
    accent: accent ?? FALLBACK.accent,
    info: info ?? FALLBACK.info,
    success: success ?? FALLBACK.success,
    warning: warning ?? FALLBACK.warning,
    error: error ?? FALLBACK.error,
    border: border ?? FALLBACK.border,
  }
}

/** 用量越高越红：>=90 error / >=70 warning / 其余 success。 */
export function quotaColor(percentage: number, pal: ThemeColors): string {
  if (percentage >= 90) return pal.error
  if (percentage >= 70) return pal.warning
  return pal.success
}
