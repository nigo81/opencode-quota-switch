// Provider 层出口：adapter 注册表 + 凭证挑选 + 抓取编排。
//
// 设计约束：凭证只来自宿主 provider 列表（api.state.provider 逐字段收窄出的 ProviderLike），
// 不读 auth.json、不落盘、不打日志。UI 层只认本文件导出的 ProviderAdapter / PROVIDERS /
// fetchQuota / availableAdapters，不要直接 import 单个 adapter 模块。

import { pickProvider } from "../http.js"
import type { ProviderLike, ProviderQuota } from "../types.js"
import { deepseekAdapter } from "./deepseek.js"
import { glmAdapter } from "./glm.js"
import { kimiAdapter } from "./kimi.js"
import { minimaxAdapter } from "./minimax.js"

export type ProviderAdapter = {
  /** stable id, e.g. "glm" | "minimax" | "kimi" | "deepseek" */
  id: string
  /** display name, e.g. "GLM" | "MiniMax" | "Kimi" | "DeepSeek" */
  label: string
  /** does this host provider entry belong to this adapter? */
  match: (p: ProviderLike) => boolean
  /** optional tie-breaker when several entries match (prefer this one) */
  prefer?: (p: ProviderLike) => boolean
  fetch: (p: ProviderLike) => Promise<ProviderQuota>
}

export { deepseekAdapter, glmAdapter, kimiAdapter, minimaxAdapter }

/** 面板展示顺序：GLM、MiniMax、Kimi、DeepSeek */
export const PROVIDERS: readonly ProviderAdapter[] = [glmAdapter, minimaxAdapter, kimiAdapter, deepseekAdapter]

function nonEmpty(s: string | undefined): boolean {
  return s != null && s.trim() !== ""
}

/** provider 对象逐字段运行时校验，不直接信任 SDK 类型形状 */
type ProviderSource = { state: { provider: readonly unknown[] } }

export function providerList(api: ProviderSource): ProviderLike[] {
  return api.state.provider.map((p): ProviderLike => {
    const rec = asRecordOf(p)
    const options = rec?.options
    const optionsRec = asRecordOf(options)
    return {
      id: typeof rec?.id === "string" ? rec.id : undefined,
      name: typeof rec?.name === "string" ? rec.name : undefined,
      baseURL: typeof optionsRec?.baseURL === "string" ? optionsRec.baseURL : undefined,
      apiKey: typeof optionsRec?.apiKey === "string" ? optionsRec.apiKey : undefined,
    }
  })
}

function asRecordOf(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * 把 OpenCode 的 providerID（如 "minimax-cn-coding-plan"）映射到 adapter。
 * 只拿得到 id 时用各 adapter 自己的 match 规则探一遍，按 PROVIDERS 顺序取第一个命中。
 * 返回 undefined 表示该 id 不是本插件支持的 provider。
 */
export function adapterForProviderId(providerId: string): ProviderAdapter | undefined {
  return PROVIDERS.find((a) => a.match({ id: providerId }))
}

/** 挑出最合适的宿主 provider 条目并抓取配额；没有匹配条目时抛中文错误由 UI 展示 */
export function fetchQuota(adapter: ProviderAdapter, providers: readonly ProviderLike[]): Promise<ProviderQuota> {
  const p = pickProvider(providers, adapter.match, adapter.prefer)
  if (!p) throw new Error(`未找到 ${adapter.label} 的 provider 配置（host provider 列表里没有可匹配条目）`)
  return adapter.fetch(p)
}

/**
 * 该条目是否已具备可用凭证。
 * 四家 adapter 现在都带兜底站点（见各自 DEFAULT_* 常量），所以只要有 apiKey 就能定位接口，
 * baseURL 缺失不再是阻塞——这是 v2.0.21 宿主没有 api.state、只能从 auth.json 取 key 的前提。
 */
function usableEntry(adapter: ProviderAdapter, p: ProviderLike | undefined): boolean {
  void adapter
  return nonEmpty(p?.apiKey)
}

/** 所有已配置可用凭证的 adapter，按 PROVIDERS 展示顺序 */
export function availableAdapters(providers: readonly ProviderLike[]): ProviderAdapter[] {
  return PROVIDERS.filter((a) => usableEntry(a, pickProvider(providers, a.match, a.prefer)))
}

export type { ProviderLike, ProviderQuota } from "../types.js"
