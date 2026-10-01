/**
 * opencode-quota-switch — TUI 侧栏「跟随当前 provider」的套餐用量面板
 *
 * 编排层：判定活跃 provider → 取 adapter → 拉数据 → 交给 Solid 面板渲染。
 * 判定逻辑在 ./src/active-provider（零依赖纯函数），取数在 ./src/providers，界面在 ./src/ui。
 */
import { createSignal } from "solid-js"
import { createComponent } from "@opentui/solid"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { detectActiveProvider } from "./src/active-provider.js"
import { authFileProviders, authFileTrace } from "./src/authfile.js"
import { availableAdapters, adapterForProviderId, fetchQuota } from "./src/providers/index.js"
import { QuotaPanel } from "./src/ui/index.js"
import type { ProviderLike, QuotaSnapshot } from "./src/types.js"

/** 面板头部显示的版本号，与 package.json 保持一致 */
const PLUGIN_VERSION = "0.1.0"

/**
 * 排障 trace：宿主加载 TUI 插件时，槽位注册与渲染这两阶段不写任何日志，
 * 面板不显示时无法从 opencode.log 区分「没加载 / 没注册 / 没渲染」。
 * 这里同步追加到文件（同步写不会被进程退出吞掉）。
 *
 * ⚠️ 默认完全静默，要开必须自己 export 环境变量（任意非空值即开）：
 *     OPENCODE_QUOTA_SWITCH_TRACE=1 opencode
 * 之前是无条件写 `/tmp/opencode-quota-switch.log`，这个仓是 **公开插件**，
 * 任意用户装上就往 /tmp 落一个 0644 文件——同机别的用户能直接读到，
 * 里面还有 `~/.local/share/opencode/auth.json` 这种带用户名的绝对路径。
 * 而且 watchTimer 3s 一轮、约 10KB/分钟，长挂一天能涨到十几 MB。
 * 三处一起收紧：默认不写 → 落 `~/.local/state/` 且 0600 → 超 512KB 清空重写。
 */
const TRACE_ENABLED =
  process.env.OPENCODE_QUOTA_SWITCH_TRACE !== undefined &&
  process.env.OPENCODE_QUOTA_SWITCH_TRACE !== ""
const TRACE_MAX_BYTES = 512 * 1024
const TRACE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "quota-switch.log")

/**
 * trace 里绝不出现 home 绝对路径（含用户名）。这条是兜底：具体业务日志自己
 * 也要按需脱敏（见 authFileTraceSafe），但万一漏了，home 前缀至少会被压成 ~。
 */
function redactHome(s: string): string {
  const home = os.homedir()
  return home ? s.split(home).join("~") : s
}

function trace(msg: string): void {
  if (!TRACE_ENABLED) return
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true })
    // open 的 mode 只在**创建**时生效，碰上历史遗留的宽权限文件不会自动收紧，
    // 所以写入前显式 chmod 一次 0600（trace 默认关闭，这点开销无所谓）
    try {
      fs.chmodSync(TRACE_FILE, 0o600)
    } catch {
      /* 文件还不存在：下面 open 时用 0600 建出来 */
    }
    const fd = fs.openSync(TRACE_FILE, "a", 0o600)
    try {
      // 长挂进程不让日志无限膨胀：超阈值就清空重写（O_APPEND 没法原地截断）
      if (fs.fstatSync(fd).size > TRACE_MAX_BYTES) {
        fs.ftruncateSync(fd, 0)
        fs.writeSync(fd, `[${new Date().toISOString()}] (超过 ${TRACE_MAX_BYTES}B，日志已清空)\n`)
        return
      }
      fs.writeSync(fd, `[${new Date().toISOString()}] ${redactHome(msg)}\n`)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* trace 失败不影响插件功能 */
  }
}
trace(`=== 模块加载 (pid=${process.pid}) ===`)

/**
 * authFileTrace() 的首段是 auth.json 的**绝对路径**（含用户名，见
 * src/authfile.ts 的 readAuthFile → from）。公开插件的 trace 随时可能被贴进
 * issue，所以这里只留 basename：变成 `auth.json → [provider 列表]`。
 * 不去改 authfile.ts：那边本来是给本机人看的原始信息，脱敏放在调用点。
 */
function authFileTraceSafe(): string {
  const raw = authFileTrace()
  const i = raw.indexOf("→")
  if (i < 0) return path.basename(raw)
  return `${path.basename(raw.slice(0, i).trim())} ${raw.slice(i)}`
}

type SwitchOptions = {
  /** 白名单，空/缺省 = 全部启用。值是 adapter id 或展示名 */
  providers?: string[]
  /** 刷新间隔毫秒，默认 60000，下限 15000 */
  intervalMs?: number
  /** 面板标题前缀，默认按 provider 名自动生成 */
  title?: string
}

function readOptions(raw: Record<string, unknown> | undefined): SwitchOptions {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
  return { providers: list(raw?.providers), intervalMs: num(raw?.intervalMs), title: str(raw?.title) }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * 合并两个凭证来源：宿主 provider 列表（权威，能拿到 baseURL）+ auth.json 兜底。
 *
 * v2.0.21 实测宿主没有 api.state，`api.state?.provider` 恒为 undefined，第一个来源通常是空的；
 * auth.json 那条路才是实际生效的。合并时宿主条目优先（同一个 id 保留带 baseURL 的那份），
 * 因为 baseURL 能区分 coding 端点与 paas 端点，auth.json 只有一把 key。
 * 必须在调用时惰性读取，且宿主不打印 setup 内的异常栈，所以只记 getter 不在 setup 阶段取值。
 */
function hostProviders(api: TuiPluginApi): () => ProviderLike[] {
  return () => {
    const list = (api as { state?: { provider?: readonly unknown[] } }).state?.provider
    const fromHost: ProviderLike[] = Array.isArray(list)
      ? list.map((p: unknown): ProviderLike => {
          const rec = asRecord(p)
          const options = asRecord(rec?.options)
          const id = rec?.id
          const name = rec?.name
          const baseURL = options?.baseURL
          const apiKey = options?.apiKey
          return {
            id: typeof id === "string" ? id : undefined,
            name: typeof name === "string" ? name : undefined,
            baseURL: typeof baseURL === "string" ? baseURL : undefined,
            apiKey: typeof apiKey === "string" ? apiKey : undefined,
          }
        })
      : []

    const merged: ProviderLike[] = [...fromHost]
    for (const entry of authFileProviders()) {
      const existing = merged.find((p) => p.id === entry.id)
      if (!existing) merged.push(entry)
      else if (!existing.apiKey) existing.apiKey = entry.apiKey
    }
    return merged
  }
}

/**
 * 槽位注册：宿主有两代 API 并存，运行时特性探测。
 * 新代（宿主 v2.0.21 实际实现，类型包尚未收录）：api.ui.slot({prepend, render})
 * 旧代（1.15.10 类型包里有）：api.slots.register({order, slots})
 * 槽名也不同：sidebar.content（点）vs sidebar_content（下划线）。
 * 写死任何一代都会在另一代上静默不渲染，故两条都探测。
 */
function registerSidebarSlot(
  api: TuiPluginApi,
  render: () => unknown,
): { ok: boolean; dispose?: () => void } {
  try {
    const modern = (api.ui as { slot?: (cfg: Record<string, unknown>) => (() => void) | void } | undefined)
      ?.slot
    if (typeof modern === "function") {
      trace("注册：走新代 api.ui.slot，槽名 sidebar.content")
      const off = modern.call(api.ui, { prepend: "sidebar.content", render })
      return { ok: true, dispose: typeof off === "function" ? off : undefined }
    }
    trace(`注册：新代 api.ui.slot 不存在（api.ui=${api.ui === undefined ? "undefined" : typeof api.ui}）`)
    const register = api.slots?.register
    if (typeof register !== "function") {
      trace("注册失败：api.ui.slot 与 api.slots.register 都不存在")
      return { ok: false }
    }
    // 旧代 register 返回 string 句柄（插件 id），不是 disposer，故无可清理对象
    trace("注册：走旧代 api.slots.register，槽名 sidebar_content")
    register.call(api.slots, {
      order: 40,
      slots: { sidebar_content: render },
    } as unknown as Parameters<typeof register>[0])
    return { ok: true }
  } catch (e) {
    trace(`注册抛异常: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return { ok: false }
  }
}

/**
 * 注册 `/quota-refresh`：两代命令 API 特性探测。
 * 新代 keymap.layer（宿主实现，类型包未收录）/ 旧代 command.register（已 deprecated 但类型里有）。
 * 两条都不可用时静默跳过——面板仍会按 interval 自动刷新。
 */
function registerRefreshCommand(api: TuiPluginApi, refresh: () => void): () => void {
  const layer = (api.keymap as { layer?: (fn: () => unknown) => unknown }).layer
  if (typeof layer === "function") {
    // 实测 v2.0.21 走这条会抛 `Keymap.Provider is missing`（setup 阶段 keymap provider
    // 尚未就绪）。命令只是锦上添花，抛了就静默降级，不能让它中断 setup 主体。
    try {
      const off = layer.call(api.keymap, () => ({
        mode: "global",
        commands: [
          {
            id: "quota-switch.refresh",
            title: "Quota: 立即刷新",
            description: "立即重新拉取当前 provider 的套餐用量",
            group: "Quota",
            palette: true,
            slash: { name: "quota-refresh" },
            run: refresh,
          },
        ],
      }))
      trace("命令注册成功：/quota-refresh")
      return typeof off === "function" ? (off as () => void) : () => {}
    } catch (e) {
      trace(`keymap.layer 抛异常，降级（不影响自动刷新）: ${e instanceof Error ? e.message : String(e)}`)
      return () => {}
    }
  }
  const register = api.command?.register
  if (typeof register !== "function") return () => {}
  try {
    return register.call(api.command, () => [
      {
        title: "立即刷新套餐用量",
        value: "quota-refresh",
        description: "立即重新拉取当前 provider 的套餐用量",
        category: "Quota",
        slash: { name: "quota-refresh" },
        onSelect: refresh,
      },
    ])
  } catch (e) {
    trace(`command.register 抛异常，降级: ${e instanceof Error ? e.message : String(e)}`)
    return () => {}
  }
}

/** 渲染器未就绪时上游会漏注册，轮询到就绪为止，1.5s 兜底（沿用上游实测做法） */
function whenRendererReady(api: TuiPluginApi, run: () => void): () => void {
  if (api.renderer?.isRunning) {
    run()
    return () => {}
  }
  const poll = setInterval(() => {
    if (api.renderer?.isRunning) {
      clearInterval(poll)
      clearTimeout(fallback)
      run()
    }
  }, 50)
  const fallback = setTimeout(() => {
    clearInterval(poll)
    run()
  }, 1500)
  return () => {
    clearInterval(poll)
    clearTimeout(fallback)
  }
}

const tui: TuiPlugin = async (api, options) => {
 try {
  trace(`setup 开始 renderer=${String(api.renderer?.isRunning)}`)
  // 排障用：把宿主实际给了什么打出来。setup 阶段 api.state 为 undefined，
  // 与类型声明（api.state: TuiState）不符，故不能假设字段一定存在。
  trace(`api 成员: ${Object.keys(api as unknown as Record<string, unknown>).join(",")}`)
  trace(
    `api 子成员: ui=[${Object.keys((api.ui ?? {}) as Record<string, unknown>).join(",")}] ` +
      `slots=[${Object.keys((api.slots ?? {}) as Record<string, unknown>).join(",")}]`,
  )
  // 逐个探测未知成员的形状：真实运行时与 1.15.10 类型声明不一致，只能实测
  for (const key of ["data", "options", "keymap", "client", "storage", "model"] as const) {
    const v = (api as unknown as Record<string, unknown>)[key]
    const kind = v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v
    const sub =
      v !== null && typeof v === "object"
        ? `[${Object.keys(v as Record<string, unknown>).slice(0, 20).join(",")}]`
        : ""
    trace(`  api.${key} = ${kind}${sub}`)
  }
  const opts = readOptions(options as Record<string, unknown> | undefined)
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 60_000)
  // 惰性读取：setup 阶段 api.state 还是 undefined，不能在这里取值
  const getProviders = hostProviders(api)
  const allowed = opts.providers
  const candidates = (): ReturnType<typeof availableAdapters> =>
    availableAdapters(getProviders()).filter(
      (a) => !allowed || allowed.length === 0 || allowed.some((n) => n === a.id || n === a.label),
    )

  const [snapshot, setSnapshot] = createSignal<QuotaSnapshot | null>(null)
  const [title, setTitle] = createSignal(opts.title ?? "套餐用量")

  // ---------------------------------------------------------------- 活跃 provider
  // v2.0.21 没有 api.state，槽位 render 回调也不传 session_id（trace 实测
  // `render 被调用 session=(none)`），所以活跃 provider 只能靠探测宿主模型状态。
  // 探测是异步的，结果缓存在 detectedProviderID 里供同步的 activeAdapter 读。
  let detectedProviderID: string | undefined
  /** 是否曾经成功探测到过活跃 provider。false 时面板显示「探测中…」而不是拿 GLM 冒充 */
  let hasDetected = false
  let probeInFlight = false
  async function refreshActiveProvider(): Promise<void> {
    if (probeInFlight) return
    probeInFlight = true
    try {
      // 白名单 = 本插件实际拿得到凭证的 opencode providerID（如 minimax-cn-coding-plan），
      // 探测结果必须落在这个集合内才采信，否则 api.data.session.status() 的 "idle" 之类会被当 provider
      const known = getProviders()
        .map((p) => p.id)
        .filter((x): x is string => typeof x === "string" && x !== "")
      const r = await detectActiveProvider(api, [], known)
      r.notes.forEach((n) => trace(`  探测: ${n}`))
      // 探测失败时保留上一次成功的值。之前这里无条件覆盖成 undefined，
      // activeAdapter() 于是回落到 candidates[0]（GLM），面板每 3s 闪一次。
      if (r.providerID === undefined) {
        trace(`探测未命中，沿用上次结果 ${detectedProviderID ?? "(无，仍显示默认)"}`)
        return
      }
      if (r.providerID !== detectedProviderID) {
        trace(`活跃 provider: ${detectedProviderID ?? "(无)"} → ${r.providerID}`)
        detectedProviderID = r.providerID
        hasDetected = true
      }
    } catch (e) {
      trace(`探测活跃 provider 抛异常: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    } finally {
      probeInFlight = false
    }
  }

  function activeAdapter() {
    const list = candidates()
    const byId = detectedProviderID ? adapterForProviderId(detectedProviderID) : undefined
    if (byId && list.includes(byId)) return byId
    if (byId) return byId
    return list[0]
  }

  /** 面板标题：`${provider} Quota`，与参考实现 opencode-glm-vistatus 的 `GLM Quota v1.5.0` 对齐 */
  function panelTitle(): string {
    // 还没探测到活跃 provider 时不写死 GLM 的名字，否则标题先于数据误导
    if (!hasDetected) return "套餐 Quota"
    return `${activeAdapter()?.label ?? "套餐"} Quota`
  }

  let lastFetch = 0
  let inFlight = false
  let retryCount = 0
  /**
   * 请求序号：切 provider 时，旧 provider 的慢响应可能后到，把新结果盖掉——
   * 用户看到的是「标题已经切到新 provider，内容还是上一家的额度」。
   * 做法是**在 await 之前领号**（而不是之后 ++），回来时号不是最新的就丢弃。
   */
  let fetchSeq = 0
  /** dispose 之后不再重排重试、不再触发新的一轮 load */
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  /** 探测活跃 provider 是异步的，首次可能扑空，阶梯重试几次 */
  function scheduleRetry(): void {
    if (stopped) return
    if (retryCount >= 6) return
    const delay = Math.min(4000, 300 * 2 ** retryCount)
    retryCount += 1
    // 句柄必须留着：dispose 要能 clearTimeout，否则插件卸载后这一轮还会
    // 跑起来 load(true) 并再排下一轮，dispose 之后仍然在打接口
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (stopped) return
      void load(true)
    }, delay)
  }

  /**
   * @returns true = 本轮真的跑了（或主动渲染了探测中状态）；false = 被跳过。
   *         调用方（watchTimer）靠这个返回值判断要不要补一次，否则「已有请求
   *         在飞 → 直接丢弃」会把 provider 切换整个吞掉：标题已经切成新
   *         provider，内容还停在上一家，正是 #2 要消灭的那个现象。
   * @param probed 调用方**已经探好**的活跃 provider（watchTimer 每 3s 探过一次）。
   *        传了就跳过 load 内部的 refreshActiveProvider()：切 provider 那一瞬间
   *        session.list() 会被打两遍，两次结果还可能打架，白花一次往返。
   *        注意值本身不覆盖 detectedProviderID —— refreshActiveProvider() 已经
   *        写进去了，这里只是复用，不重复写。
   */
  async function load(force: boolean, probed?: { providerID: string | undefined }): Promise<boolean> {
    const now = Date.now()
    if (!force && now - lastFetch < intervalMs - 1000) return false
    if (inFlight) {
      trace("load：已有请求在飞，本次跳过")
      return false
    }
    // ⚠️ 必须在第一个 await 之前置位。原来它夹在 `await refreshActiveProvider()`
    // 后面，守卫窗口正好落在最需要的 await 期间：watchTimer 判定 provider 变化
    // → load(true) 的探测还没返回，session.idle 触发的 load(true) 就一起冲进来了。
    inFlight = true
    try {
      if (probed) {
        trace(`load：复用调用方已探结果 provider=${probed.providerID ?? "(未命中)"}`)
      } else {
        // 每轮取数前先重新探测一次活跃 provider：用户切模型/切会话后能自动跟上
        await refreshActiveProvider()
      }
      // 还没探测到过活跃 provider：什么都不取，只显示「探测中…」。
      // 否则 activeAdapter() 会回落到候选列表首个（GLM），把 GLM 的数据
      // 冒充成当前 provider 显示——启动头几秒会闪一次 GLM。
      if (!hasDetected) {
        trace("load：活跃 provider 尚未探测到，显示探测中")
        setSnapshot({ provider: "", ok: false, error: "", detecting: true, fetchedAt: now })
        scheduleRetry()
        return true
      }
      const adapter = activeAdapter()
      if (!adapter) {
        trace(`load：未找到可用 adapter（第 ${retryCount} 次，将重试）`)
        setSnapshot({ provider: "—", ok: false, error: "未找到可用的套餐 provider", fetchedAt: now })
        scheduleRetry()
        return true
      }
      retryCount = 0
      lastFetch = now
      const mySeq = ++fetchSeq
      try {
        const quota = await fetchQuota(adapter, getProviders())
        // 过期响应直接丢：晚到的旧 provider 数据会盖掉新的，用户看到串台。
        // 对调用方来说这算「跑过了」——已经有更新的请求在途，不用补。
        if (mySeq !== fetchSeq) {
          trace(`丢弃过期响应 provider=${adapter.label} seq=${mySeq}/${fetchSeq}`)
          return true
        }
        trace(`load 成功 provider=${adapter.label} windows=${quota.windows.length} extras=${quota.extras.length}`)
        setTitle(panelTitle())
        setSnapshot({ provider: adapter.label, ok: true, quota, fetchedAt: now })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 失败路径同样要过序号：旧 provider 的报错不该盖掉新 provider 的成功结果
        if (mySeq !== fetchSeq) {
          trace(`丢弃过期失败 provider=${adapter.label} seq=${mySeq}/${fetchSeq} err=${msg}`)
          return true
        }
        trace(`load 失败 provider=${adapter.label} err=${msg}`)
        setSnapshot({
          provider: adapter.label,
          ok: false,
          error: msg,
          fetchedAt: now,
        })
      }
      return true
    } finally {
      inFlight = false
    }
  }

  // 槽位 props 里的 session_id 决定「当前 provider」，由宿主在切换会话时重新调用
  let sessionID: string | undefined
  /**
   * 面板实例缓存。宿主每注册/重挂一次侧栏就可能再调一次 render，
   * 而 render 里 `createComponent(QuotaPanel, …)` 每调一次就造一个**全新实例**：
   * 每个实例自带 1s setInterval（panel.tsx 的 tickTimer）、kv 冷启轮询
   * （restoreConfig 那条 10ms 轮询）和一整排 createEffect/createMemo，
   * 宿主多调一次渲染这些就整体翻倍（panel.tsx 里「目标 r.notes≈60」就是按
   * 单实例估的）。参考实现 opencode-glm-vistatus 也是显式
   * `if (!card) card = new QuotaCard(...)`。
   * props 里传的一直是 signal 函数本身（snapshot/title），所以缓存下来的
   * 实例读到的仍然是最新值，缓存不影响数据刷新。
   */
  let panel: unknown
  let renderCount = 0
  const render = (slotProps?: unknown): unknown => {
    renderCount += 1
    const props = asRecord(slotProps)
    const next = typeof props?.session_id === "string" ? props.session_id : sessionID
    // 每次 render 都打一行带计数的 trace：之前只在 session_id 变化时打，
    // 宿主到底调了几次 render 从日志里根本看不出来，所以「多实例」一直没被发现。
    // trace 现在默认关闭（要 export OPENCODE_QUOTA_SWITCH_TRACE），刷屏无所谓。
    trace(`render #${renderCount} session=${next ?? "(none)"}${panel === undefined ? "（创建面板实例）" : "（复用实例）"}`)
    if (next !== sessionID) {
      sessionID = next
      setTitle(panelTitle())
      void load(true)
    }
    // 必须经 createComponent 在宿主的响应式 owner 内实例化。
    // 直接调用 QuotaPanel({...}) 不会建立 owner，组件不渲染（实测踩过）。
    // ??= 保证只在第一次 render 时真正实例化。
    return (panel ??= createComponent(QuotaPanel, {
      snapshot,
      title,
      theme: api.theme,
      kv: api.kv,
      version: PLUGIN_VERSION,
    }))
  }

  const stopReady = whenRendererReady(api, () => {
    const { ok, dispose } = registerSidebarSlot(api, render)
    if (!ok) {
      guard("toast", () => api.ui.toast({ variant: "error", message: "quota-switch: 未能注册 sidebar 插槽" }))
    } else if (dispose) {
      guard("onDispose(dispose)", () => api.lifecycle.onDispose(dispose))
    }
    guard("setTitle", () => setTitle(panelTitle()))
    void load(true)
  })

  // /quota-refresh：直接强制绕过 interval 节流重取一次。
  // 这里**不需要**再 bump 什么刷新信号：面板读的是 snapshot signal，setSnapshot
  // 一改它自己就重算了。原来那条「信号 → panel 空转 effect」的链路已整条删除。
  const offRefresh = registerRefreshCommand(api, () => {
    void load(true)
  })

  // 消息更新 = 可能换 provider；空闲 = 一次问答结束，两个都要重新判定。
  // v2.0.21 实测没有 api.event，事件总线是 api.data.on（成员 on/listen/session/project/…）。
  trace(`准备注册，candidates=${candidates().map((c) => c.id).join(",") || "(无)"}`)
  trace(`凭证来源 auth.json: ${authFileTraceSafe()}`)
  trace(`合并后 provider 条目: ${getProviders().map((p) => `${p.id}${p.baseURL ? "(有baseURL)" : ""}`).join(",") || "(无)"}`)
  const dataNS = asRecord(asRecord(api)?.data)
  const dataOn = dataNS?.on as ((e: string, cb: () => void) => unknown) | undefined
  const offs = (
    guard("data.on", () =>
      typeof dataOn === "function"
        ? [
            dataOn.call(dataNS, "message.updated", () => void load(false)),
            dataOn.call(dataNS, "session.updated", () => void load(false)),
            dataOn.call(dataNS, "session.idle", () => void load(true)),
          ]
        : [],
    ) ?? []
  ).filter((off): off is () => void => typeof off === "function")

  const timer = setInterval(() => void load(false), intervalMs)

  // 切 provider 的响应要快：每 3s 只探不取，只有探到变化时才重新取数。
  // 60s 的取数节流保持不变，所以这个轮询几乎不产生额外请求。
  // 探到的结果直接透传给 load：否则 load 内部又会 refreshActiveProvider() 一遍，
  // 切 provider 那一瞬间 session.list() 白打两次。
  const watchTimer = setInterval(() => {
    void (async () => {
      if (stopped) return
      const before = detectedProviderID
      await refreshActiveProvider()
      if (stopped) return
      if (detectedProviderID !== before) {
        setTitle(panelTitle())
        // load 被跳过（慢请求在飞）的话这次切换就丢了，补一轮阶梯重试
        if (!load(true, { providerID: detectedProviderID })) {
          trace("watchTimer：本次 load 被跳过，排一轮重试")
          scheduleRetry()
        }
      }
    })()
  }, 3000)

  const dispose = (): void => {
    stopped = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    clearInterval(timer)
    clearInterval(watchTimer)
    stopReady()
    offRefresh()
    offs.forEach((off) => off())
  }
  // v2.0.21 没有 api.lifecycle.onDispose（trace 实测 undefined），试几个可能的挂载点，挂不上就算了：
  // 泄漏的只是一个 setInterval，插件重载时会被宿主整体换掉。
  for (const [obj, path] of [
    [api, "api.lifecycle.onDispose"],
    [asRecord(api)?.app, "api.app.onDispose"],
    [asRecord(api)?.renderer, "api.renderer.onDispose"],
  ] as const) {
    const fn = (obj as Record<string, unknown> | undefined)?.onDispose
    if (typeof fn === "function") {
      guard(path, () => (fn as (cb: () => void) => void).call(obj, dispose))
      break
    }
  }
  trace(`setup 走完，未抛异常（offs=${offs.length} timer=${intervalMs}ms watch=3000ms）`)
  } catch (e) {
    // 宿主调用 setup 时若抛异常，外层不会打印栈，排障全靠这里。
    // 不再 re-throw：槽位已经注册成功，抛出去反而可能让宿主把整块 UI 拆掉。
    trace(`setup 抛异常（已吞掉，不影响已注册的槽位）: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  }
}

/** setup 内任何一步失败都只记录、不中断——面板本体才是主线，附属能力一律降级 */
function guard<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (e) {
    trace(`${label} 抛异常，已跳过: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return undefined
  }
}

/**
 * 双格式导出，缺一不可：
 * - `tui`   → V1 宿主读这个字段
 * - `setup` → V2 宿主读这个字段
 * 只导出 `tui` 时，模块顶层代码会执行（看起来像加载成功），但入口函数永远
 * 不会被调用，插件静默无任何表现——实测踩过：trace 只写出一行「模块加载」。
 * 两个字段指向同一个函数体，避免两代行为分叉。
 */
export default { id: "quota-switch", tui, setup: tui }
