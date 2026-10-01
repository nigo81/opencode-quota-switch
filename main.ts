/**
 * opencode-quota-switch — TUI 侧栏「跟随当前 provider」的套餐用量面板
 *
 * 编排层：判定活跃 provider → 取 adapter → 拉数据 → 交给 Solid 面板渲染。
 * 判定逻辑在 ./src/active-provider（零依赖纯函数），取数在 ./src/providers，界面在 ./src/ui。
 */
import { createSignal } from "solid-js"
import { createComponent } from "@opentui/solid"
import fs from "node:fs"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { resolveActiveProvider } from "./src/active-provider.js"
import { authFileProviders, authFileTrace } from "./src/authfile.js"
import { availableAdapters, adapterForProviderId, fetchQuota } from "./src/providers/index.js"
import { QuotaPanel } from "./src/ui/index.js"
import type { ProviderLike, QuotaSnapshot } from "./src/types.js"

/** 面板头部显示的版本号，与 package.json 保持一致 */
const PLUGIN_VERSION = "0.1.0"

/**
 * 排障 trace：宿主加载 TUI 插件时，槽位注册与渲染这两阶段不写任何日志，
 * 面板不显示时无法从 opencode.log 区分「没加载 / 没注册 / 没渲染」。
 * 这里同步追加到文件（appendFileSync 不会被进程退出吞掉）。
 * 排障完成后可整段删除。
 */
const TRACE_FILE = "/tmp/opencode-quota-switch.log"
function trace(msg: string): void {
  try {
    fs.appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* trace 失败不影响插件功能 */
  }
}
trace(`=== 模块加载 (pid=${process.pid}) ===`)

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
  const [refreshTick, setRefreshTick] = createSignal(0)

  // 活跃 provider：会话内最近一条消息优先，其次配置默认模型
  // api.state 在 setup 阶段为 undefined，所有访问都走可选链
  function activeAdapter(sessionID: string | undefined) {
    const st = (api as { state?: { session?: { messages?: (id: string) => readonly unknown[] }; config?: unknown } })
      .state
    let messages: readonly unknown[] = []
    try {
      const m = sessionID ? st?.session?.messages?.(sessionID) : undefined
      if (Array.isArray(m)) messages = m
    } catch {
      messages = []
    }
    const active = resolveActiveProvider({ messages, config: st?.config })
    const byId = active.providerID ? adapterForProviderId(active.providerID) : undefined
    const list = candidates()
    // 判定到的 provider 不在候选里（未认证/被白名单排除）→ 回落到首个可用 adapter
    return byId && list.includes(byId) ? byId : (byId ?? list[0])
  }

  let lastFetch = 0
  let inFlight = false
  let retryCount = 0
  /** 宿主填充 api.state 是异步的，首次取数可能扑空，阶梯重试几次 */
  function scheduleRetry(sessionID: string | undefined): void {
    if (retryCount >= 6) return
    const delay = Math.min(4000, 300 * 2 ** retryCount)
    retryCount += 1
    setTimeout(() => void load(sessionID, true), delay)
  }
  async function load(sessionID: string | undefined, force: boolean): Promise<void> {
    const now = Date.now()
    if (!force && now - lastFetch < intervalMs - 1000) return
    if (inFlight) return
    const adapter = activeAdapter(sessionID)
    if (!adapter) {
      trace(`load：未找到可用 adapter（第 ${retryCount} 次，将重试）`)
      setSnapshot({ provider: "—", ok: false, error: "未找到可用的套餐 provider", fetchedAt: now })
      scheduleRetry(sessionID)
      return
    }
    retryCount = 0
    inFlight = true
    lastFetch = now
    try {
      const quota = await fetchQuota(adapter, getProviders())
      trace(`load 成功 provider=${adapter.label} windows=${quota.windows.length} extras=${quota.extras.length}`)
      setSnapshot({ provider: adapter.label, ok: true, quota, fetchedAt: now })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      trace(`load 失败 provider=${adapter.label} err=${msg}`)
      setSnapshot({
        provider: adapter.label,
        ok: false,
        error: msg,
        fetchedAt: now,
      })
    } finally {
      inFlight = false
    }
  }

  // 槽位 props 里的 session_id 决定「当前 provider」，由宿主在切换会话时重新调用
  let sessionID: string | undefined
  const render = (slotProps?: unknown): unknown => {
    const props = asRecord(slotProps)
    const next = typeof props?.session_id === "string" ? props.session_id : sessionID
    if (next !== sessionID) {
      sessionID = next
      setTitle(`${activeAdapter(sessionID)?.label ?? "套餐"} 额度`)
      void load(sessionID, true)
    }
    // 必须经 createComponent 在宿主的响应式 owner 内实例化。
    // 直接调用 QuotaPanel({...}) 不会建立 owner，组件不渲染（实测踩过）。
    trace(`render 被调用 session=${next ?? "(none)"}`)
    return createComponent(QuotaPanel, {
      snapshot,
      title,
      theme: api.theme,
      kv: api.kv,
      refreshSignal: refreshTick,
      version: PLUGIN_VERSION,
    })
  }

  const stopReady = whenRendererReady(api, () => {
    const { ok, dispose } = registerSidebarSlot(api, render)
    if (!ok) {
      guard("toast", () => api.ui.toast({ variant: "error", message: "quota-switch: 未能注册 sidebar 插槽" }))
    } else if (dispose) {
      guard("onDispose(dispose)", () => api.lifecycle.onDispose(dispose))
    }
    guard("setTitle", () => setTitle(`${activeAdapter(sessionID)?.label ?? "套餐"} 额度`))
    void load(sessionID, true)
  })

  // /quota-refresh：bump 信号让面板立即重取，同时强制绕过 interval 节流
  const offRefresh = registerRefreshCommand(api, () => {
    setRefreshTick(Date.now())
    void load(sessionID, true)
  })

  // 消息更新 = 可能换 provider；空闲 = 一次问答结束，两个都要重新判定。
  // v2.0.21 实测真实成员里没有 api.event，故整段降级为可选。
  trace(`准备注册，candidates=${candidates().map((c) => c.id).join(",") || "(无)"}`)
  trace(`凭证来源 auth.json: ${authFileTrace()}`)
  trace(`合并后 provider 条目: ${getProviders().map((p) => `${p.id}${p.baseURL ? "(有baseURL)" : ""}`).join(",") || "(无)"}`)
  const offs = (
    guard("event.on", () =>
      typeof (api.event as { on?: unknown } | undefined)?.on === "function"
        ? [
            api.event.on("message.updated", () => void load(sessionID, false)),
            api.event.on("session.updated", () => void load(sessionID, false)),
            api.event.on("session.idle", () => void load(sessionID, true)),
          ]
        : [],
    ) ?? []
  ).filter((off): off is () => void => typeof off === "function")

  const timer = setInterval(() => void load(sessionID, false), intervalMs)

  guard("lifecycle.onDispose", () =>
    api.lifecycle.onDispose(() => {
      clearInterval(timer)
      stopReady()
      offRefresh()
      offs.forEach((off) => off())
    }),
  )
  trace(`setup 走完，未抛异常（offs=${offs.length} timer=${intervalMs}ms）`)
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
