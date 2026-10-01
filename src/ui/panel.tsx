/**
 * 侧栏额度面板（Solid）。
 *
 * 视觉与交互对齐 opencode-glm-vistatus@1.5.0 的 GlmQuotaPanel
 * （dist/tui.js `src/ui/panel.tsx` 模块段，L714-1154），但换成 Solid 组件 +
 * 冻结契约里的 QuotaSnapshot 驱动，并修掉参考实现的三个已知问题：
 *
 * 1. 倒计时每秒真的在走（参考实现在 L841-842 把 countdown/clock 算成 frozen
 *    const 塞进节点，只有几分钟一次的数据刷新才会让它跳）。
 * 2. accent / info 真的来自宿主主题（参考的 v2 mapTheme 漏了这两项，
 *    静默回落到硬编码色，见 ./theme.ts 顶部说明）。
 * 3. usedPct === undefined 的窗口照常渲染标签（参考实现会把这类窗口按
 *    0% 画一条空条，或者干脆不显示）。
 *
 * 运行时依赖只有 solid-js / @opentui/solid / @opencode-ai/plugin，
 * 全部由宿主提供 —— 绝不能写进 package.json 的 dependencies，
 * 否则会多出一份渲染库实例，Solid 信号订阅桥不到宿主渲染循环，首帧就冻住。
 */

import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { BoxRenderable } from "@opentui/core"
import type { TuiKV, TuiTheme } from "@opencode-ai/plugin/tui"
import type { QuotaSnapshot, QuotaWindow } from "../types.js"
import {
  formatClockShort,
  formatNumber,
  formatPercentage,
  formatResetClock,
  formatResetCountdown,
  resolveResetAt,
} from "./format.js"
import { buildPalette, dimColor, quotaColor, type ThemeColors } from "./theme.js"
import {
  BAR_BRACKETS,
  BAR_GAP,
  DEFAULT_PANEL_WIDTH,
  HEADER_PREFIX,
  MIN_PANEL_WIDTH,
  PCT_WIDTH,
  progressBar,
  truncateVisual,
  UNLIMITED_GLYPH,
  visualWidth,
} from "./widgets.js"

/** kv 键名前缀，与宿主其它插件隔离。 */
export const KV_NAMESPACE = "quota_switch"

const FOLD_OPEN = "▼ "
const FOLD_SHUT = "▶ "
const SEP = "─"

export type QuotaPanelProps = {
  /** 当前 provider 的快照；首轮请求在飞时为 null */
  snapshot: () => QuotaSnapshot | null
  /** 面板标题，如 "GLM 额度" —— provider 名字由调用方给 */
  title: () => string
  theme: TuiTheme
  kv: TuiKV
  /** 递增这个数字即可强制立刻拉一次数据 */
  refreshSignal: () => number
  /** 可选：refreshSignal 真正发生变化时的回调，供 main.ts 触发立即刷新 */
  onRefresh?: () => void
  /** 可选：标题右侧的版本号，如 "1.5.0"，渲染成 `v1.5.0` */
  version?: string
}

export function QuotaPanel(props: QuotaPanelProps): JSX.Element {
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  const [borderVisible, setBorderVisible] = createSignal(true)
  // 已知 bug 修复 #1：每秒推进一次的时间源，倒计时/钟点全部由它推导。
  const [now, setNow] = createSignal(Date.now())

  let boxEl: BoxRenderable | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let kvPollTimer: ReturnType<typeof setTimeout> | undefined

  // ---------------------------------------------------------------- 主题
  // 主题未就绪的极小窗口（上游 imperative 版 L336-340 处理过同一个问题）：
  // 下面所有取色都走 buildPalette(undefined) 的 FALLBACK，渲染出一棵空树，
  // 不崩、不空指针，等宿主主题就绪后自动补上。
  const themeReady = () => props.theme.ready && !!props.theme.current
  const pal = createMemo<ThemeColors>(() => {
    // 读一次 selected：宿主换主题会换掉整个 theme 对象，这里跟着失效重算
    void props.theme.selected
    return buildPalette(themeReady() ? props.theme.current : undefined)
  })

  // ---------------------------------------------------------------- kv
  const persist = (key: string, value: unknown): void => {
    try {
      props.kv.set(`${KV_NAMESPACE}.${key}`, value)
    } catch {
      /* kv 没就绪 / 写失败：静默降级为本次会话有效 */
    }
  }

  const applyStoredConfig = (): void => {
    try {
      setOpen(props.kv.get<boolean>(`${KV_NAMESPACE}.open`, true) !== false)
      setBorderVisible(props.kv.get<boolean>(`${KV_NAMESPACE}.border`, true) !== false)
    } catch {
      /* 保持默认值 */
    }
  }

  const restoreConfig = (): void => {
    try {
      if (props.kv.ready) {
        applyStoredConfig()
        return
      }
      // kv 冷启动可能要几十毫秒：短轮询等它 ready，最多等 1s
      let tries = 0
      const poll = (): void => {
        if (props.kv.ready || ++tries > 100) {
          applyStoredConfig()
          return
        }
        kvPollTimer = setTimeout(poll, 10)
      }
      poll()
    } catch {
      /* 保持默认值 */
    }
  }

  onMount(() => {
    tickTimer = setInterval(() => setNow(Date.now()), 1000)
    restoreConfig()
  })

  onCleanup(() => {
    if (tickTimer !== undefined) clearInterval(tickTimer)
    if (kvPollTimer !== undefined) clearTimeout(kvPollTimer)
  })

  // refreshSignal 只在"真的被推进"时通知调用方，首次挂载不算。
  // main.ts 目前的 /quota-refresh 命令自己调 load()，没传 onRefresh，
  // 所以这个 effect 目前是空转的；留着是为了契约里 refreshSignal 有明确归属。
  let seenRefreshSignal = props.refreshSignal()
  createEffect(() => {
    const tick = props.refreshSignal()
    if (tick === seenRefreshSignal) return
    seenRefreshSignal = tick
    props.onRefresh?.()
  })

  // ---------------------------------------------------------------- 布局
  // 注意：`quota_switch.border` 只在挂载时读一次。要做运行中实时切换的设置菜单，
  // 得把 visible 提成 main.ts 持有的 signal 再传进来，光写 kv 面板不会跟着变。
  const gutter = createMemo(() => (borderVisible() ? 6 : 0))
  /** 内容可用列数（去掉边框左右各 1 + 内边距左右各 2） */
  const gauge = createMemo(() => panelWidth() - gutter())
  const sep = createMemo(() => SEP.repeat(Math.max(1, gauge())))

  const measure = (): void => {
    const raw = boxEl && typeof boxEl.width === "number" && boxEl.width > 0 ? boxEl.width : DEFAULT_PANEL_WIDTH
    const w = Math.max(MIN_PANEL_WIDTH, raw)
    setPanelWidth((prev) => (prev === w ? prev : w))
  }

  // 边框开关会改变可用列数，切换后重新量一次
  createEffect(() => {
    borderVisible()
    measure()
  })

  const borderProps = (): { border: boolean; borderColor?: string } =>
    borderVisible() ? { border: true, borderColor: pal().border } : { border: false }

  // ---------------------------------------------------------------- 数据
  const snap = (): QuotaSnapshot | null => props.snapshot()
  const quota = () => snap()?.quota

  /** 折叠态显示的百分比：第一个有百分比语义的窗口。 */
  const headPct = (): number | undefined => {
    for (const w of quota()?.windows ?? []) {
      if (w.usedPct !== undefined) return w.usedPct
    }
    return undefined
  }

  // ---------------------------------------------------------------- 组件
  /**
   * 右对齐的填充空格。放得下才补，放不下返回空串 —— 千万别用 Math.max(1, …)：
   * 侧栏被压窄时（标题+版本+时钟已经超宽）那 1 个空格会把整行顶出内容区，
   * opentui 随即折行，后面的行跟着串位（实测终端宽 26 时整张面板错位）。
   * 宁可少显示一个时钟，也不要折行。
   */
  const spaces = (n: number): string => (n >= 1 ? " ".repeat(n) : "")
  const padTo = (head: string, tail: string, width: number): string =>
    spaces(width - visualWidth(head) - visualWidth(tail))

  const LabeledValue = (p: { label: string; value: string }): JSX.Element => {
    // 放得下：右对齐；放不下：标签后跟一个空格，值截断
    const pad = createMemo(() => padTo(p.label, p.value, gauge()))
    const tight = createMemo(
      () => " " + truncateVisual(p.value, Math.max(1, gauge() - visualWidth(p.label) - 1)),
    )
    return (
      <text>
        <span style={{ fg: pal().info }}>{p.label}</span>
        <Show when={pad()}>
          <span style={{ fg: pal().accent }}>{pad() + p.value}</span>
        </Show>
        <Show when={!pad()}>
          <span style={{ fg: pal().accent }}>{tight()}</span>
        </Show>
      </text>
    )
  }

  const QuotaBlock = (p: { win: QuotaWindow }): JSX.Element => {
    const win = () => p.win
    // 无限量窗口（如未购周包时的周窗口）：没有百分比语义，只有 ∞。
    // resetLabel 天然为空，所以下面的重置行会自动整行跳过，无需额外判断。
    const isUnlimited = (): boolean => win().unlimited === true
    const hasPct = (): boolean => win().usedPct !== undefined
    const pct = (): number => win().usedPct ?? 0

    const usedTotal = (): string => {
      const u = win().used
      const l = win().limit
      return u !== undefined && l !== undefined ? `${formatNumber(u)}/${formatNumber(l)}` : ""
    }

    const label = (): string => truncateVisual(win().label, Math.max(1, gauge()))
    const labelPad = (): string => padTo(label(), usedTotal(), gauge())
    // 标签 + 已用/总量放不下时退化成 `标签 值`，值截断，绝不折行
    const labelTight = (): string =>
      " " + truncateVisual(usedTotal(), Math.max(1, gauge() - visualWidth(label()) - 1))

    const pctText = (): string => formatPercentage(pct())
    // 百分比右对齐成固定宽度，条形图长度才不会随 7% / 28% 抖动
    const pctPad = (): string => " ".repeat(Math.max(BAR_GAP, PCT_WIDTH - visualWidth(pctText())))
    const barWidth = (): number => Math.max(1, gauge() - BAR_BRACKETS - visualWidth(pctPad()) - visualWidth(pctText()))
    /** 条形行整行放不下（极窄侧栏）就不画条 */
    const barFits = (): boolean => gauge() - BAR_BRACKETS - visualWidth(pctPad()) - visualWidth(pctText()) >= 1

    const reset = () => resolveResetAt(win().resetLabel, now())
    // 没有钟点信息（"MM-DD"）就原样回显标签，别拿午夜 00:00 冒充真实重置时间
    const resetClock = (): string => {
      const r = reset()
      if (!r) return ""
      return r.hasClock ? formatResetClock(r.at, now()) : truncateVisual(win().resetLabel ?? "", 8)
    }
    const resetHead = (): string => truncateVisual("重置: " + formatResetCountdown(reset()!.at, now()), gauge())
    // 括号里的钟点只在塞得下时才出现
    const resetTailPad = (): string => padTo(resetHead(), resetClock(), gauge())

    return [
      <text>
        <span style={{ fg: pal().info }}>{label()}</span>
        <Show when={usedTotal() && labelPad()}>
          <span style={{ fg: pal().accent }}>{labelPad() + usedTotal()}</span>
        </Show>
        <Show when={usedTotal() && !labelPad()}>
          <span style={{ fg: pal().accent }}>{labelTight()}</span>
        </Show>
      </text>,
      // 无限量窗口：只画一个 ∞，不画条、不画百分比（hasPct 为 false 时下面的条形行自动跳过）
      <Show when={isUnlimited()}>
        <text>
          <span style={{ fg: pal().info }}>{" " + UNLIMITED_GLYPH}</span>
        </text>
      </Show>,
      // 已知 bug 修复 #3：没有百分比语义就整行不画 —— 既不画一条假的 0% 空条，
      // 也不把整个窗口藏起来。标签行右边的 used/limit 照常显示。
      <Show when={hasPct()}>
        <Show
          when={barFits()}
          fallback={
            <text>
              <span style={{ fg: quotaColor(pct(), pal()) }}>{pctPad() + pctText()}</span>
            </text>
          }
        >
          <text>
            <span style={{ fg: quotaColor(pct(), pal()) }}>[{progressBar(pct(), barWidth())}]</span>
            <span style={{ fg: pal().accent }}>{pctPad() + pctText()}</span>
          </text>
        </Show>
      </Show>,
      <Show when={reset()}>
        <text>
          <span style={{ fg: pal().muted }}>{resetHead()}</span>
          <Show when={resetClock() && resetTailPad()}>
            <span style={{ fg: dimColor(pal().muted, 0.75) }}>{" (" + resetClock() + ")"}</span>
          </Show>
        </text>
      </Show>,
    ]
  }

  const Notice = (p: { icon: string; text: string; fg: string }): JSX.Element => (
    <text>
      <span style={{ fg: p.fg }}>{p.icon + " "}</span>
      <span style={{ fg: p.fg }}>{truncateVisual(p.text, Math.max(1, gauge() - 2))}</span>
    </text>
  )

  // ---------------------------------------------------------------- 头部
  /** 版本号后缀；侧栏不够宽时直接不显示，而不是把标题顶出内容区 */
  const headMeta = (): string => {
    const tag = props.version ? ` v${props.version}` : ""
    const room = gauge() - HEADER_PREFIX - 6
    return visualWidth(props.title()) + visualWidth(tag) <= room ? tag : ""
  }
  const headTitle = (): string =>
    truncateVisual(props.title(), Math.max(1, gauge() - HEADER_PREFIX - visualWidth(headMeta())))
  const headClock = (): string => {
    const s = snap()
    return s ? formatClockShort(new Date(s.fetchedAt)) : ""
  }
  /** 标题 + 版本已经占掉的列 */
  const headPrefixW = (): number => HEADER_PREFIX + visualWidth(headTitle()) + visualWidth(headMeta())

  const foldedPct = (): string => {
    const v = headPct()
    return v === undefined ? "" : formatPercentage(v)
  }
  const headPad = (): string => spaces(gauge() - headPrefixW() - visualWidth(headClock()))
  const foldedPad = (): string => spaces(gauge() - headPrefixW() - visualWidth(foldedPct()))

  // ---------------------------------------------------------------- 主体
  const body = (): JSX.Element => {
    const s = snap()
    if (!s) return <Notice icon=">" text="加载中…" fg={pal().muted} />
    // 活跃 provider 还没探测到：这不是查询失败，是还没开始查。两者必须区分，
    // 否则启动头几秒会拿候选列表首个（GLM）的额度冒充当前 provider。
    if (s.detecting) return <Notice icon=">" text="探测当前 provider…" fg={pal().muted} />
    if (!s.ok) return <Notice icon="⚠" text={s.error ?? "查询失败"} fg={pal().error} />
    const q = s.quota
    if (!q) return <Notice icon=">" text="暂无数据" fg={pal().muted} />

    const rows: JSX.Element[] = []
    if (s.provider) rows.push(<LabeledValue label="平台:" value={s.provider} />)
    if (q.level) rows.push(<LabeledValue label="套餐:" value={q.level} />)
    for (const w of q.windows) rows.push(<QuotaBlock win={w} />)
    for (const e of q.extras) rows.push(<LabeledValue label={e.label} value={e.value} />)
    if (rows.length === 0) rows.push(<Notice icon=">" text="暂无数据" fg={pal().muted} />)
    return rows
  }

  return (
    <box
      {...borderProps()}
      ref={boxEl}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={borderVisible() ? 2 : 0}
      paddingRight={borderVisible() ? 2 : 0}
      flexDirection="column"
      gap={0}
      onSizeChange={measure}
    >
      <text onMouseUp={toggle}>
        <span style={{ fg: pal().muted }}>{open() ? FOLD_OPEN : FOLD_SHUT}</span>
        <span style={{ fg: pal().primary }}>{headTitle()}</span>
        <Show when={headMeta()}>
          <span style={{ fg: dimColor(pal().muted, 0.6) }}>{headMeta()}</span>
        </Show>
        <Show when={open() && headClock() && headPad()}>
          <span style={{ fg: dimColor(pal().muted, 0.7) }}>{headPad() + headClock()}</span>
        </Show>
        <Show when={!open() && foldedPct() && foldedPad()}>
          <span style={{ fg: quotaColor(headPct() ?? 0, pal()) }}>{foldedPad() + foldedPct()}</span>
        </Show>
      </text>
      <Show when={open()}>
        <text fg={pal().muted}>{sep()}</text>
        {body()}
      </Show>
    </box>
  )

  function toggle(): void {
    setOpen((prev) => {
      const next = !prev
      persist("open", next)
      return next
    })
  }
}
