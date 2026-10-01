/**
 * UI 层公开面。main.ts 只跟这个文件打交道。
 *
 * 面板本体（./panel.tsx）只消费 src/types.ts 里冻结的 QuotaSnapshot，
 * 不认识任何 provider —— 数据怎么来、槽位怎么注册，全在 main.ts 那边。
 *
 * 运行时依赖只有 solid-js / @opentui/solid / @opencode-ai/plugin，
 * 三者全部由宿主提供。绝不能写进 package.json 的 dependencies：
 * 多带一份渲染库实例，Solid 信号订阅桥不到宿主渲染循环，首帧就冻住
 * （upstream opencode-quota-usage 的实证事故）。
 */

export { QuotaPanel, KV_NAMESPACE } from "./panel.js"
export type { QuotaPanelProps } from "./panel.js"

export { buildPalette, dimColor, quotaColor, rgb, desaturateTo, FALLBACK, MAX_SAT } from "./theme.js"
export type { ThemeColors } from "./theme.js"

export {
  formatClockShort,
  formatNumber,
  formatPercentage,
  formatResetClock,
  formatResetCountdown,
  resolveResetAt,
  DAY_NAMES,
} from "./format.js"
export type { ResolvedReset } from "./format.js"

export {
  charColumns,
  progressBar,
  truncateVisual,
  visualWidth,
  BAR_BRACKETS,
  BAR_GAP,
  DEFAULT_PANEL_WIDTH,
  HEADER_PREFIX,
  MIN_PANEL_WIDTH,
  PCT_WIDTH,
} from "./widgets.js"
