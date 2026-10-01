// 共享数据契约：UI 层与 provider 层唯一的耦合点。
// 任何一方改动此文件，必须同步另一方——先改这里，再改实现。

/** 单个配额窗口（进度条一行）。余额类 provider 不产出 window，只产出 extra。 */
export type QuotaWindow = {
  /** 窗口名："5h" / "周" / "MCP" / "额度" */
  label: string
  /** 该窗口无限量（如 MiniMax 未购周包时周窗口恒为 status=3）。面板渲染为 ∞，不画条、无重置倒计时 */
  unlimited?: boolean
  /** 已用百分比 0-100。undefined 表示该窗口无百分比语义（不画进度条） */
  usedPct?: number
  used?: number
  limit?: number
  /** "HH:mm"（当天）或 "MM-DD"（跨天） */
  resetLabel?: string
}

/** 键值附加信息：套餐等级、余额、月消等 */
export type QuotaExtra = { label: string; value: string }

export type ProviderQuota = {
  level?: string
  windows: QuotaWindow[]
  extras: QuotaExtra[]
}

export type QuotaSnapshot = {
  /** 展示用 provider 名，如 "GLM" / "MiniMax" */
  provider: string
  ok: boolean
  error?: string
  quota?: ProviderQuota
  fetchedAt: number
  /**
   * 活跃 provider 还没探测到，尚未发起任何取数。
   * 与 ok=false 的「查询失败」区分开：这时展示「探测中…」，
   * 避免启动头几秒拿候选列表首个（GLM）的数据冒充当前 provider。
   */
  detecting?: boolean
}

/** 宿主 provider 条目的最小形状（运行时逐字段收窄，不信任 SDK 类型） */
export type ProviderLike = {
  id?: string
  name?: string
  baseURL?: string
  apiKey?: string
}
