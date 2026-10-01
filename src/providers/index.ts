// Provider 层出口：adapter 注册表 + 凭证挑选 + 抓取编排。
//
// 设计约束：凭证只来自宿主 provider 列表，不读本文件之外的旁路、不落盘、不打日志。
// UI 层只认本文件导出的 ProviderAdapter / PROVIDERS / fetchQuota / availableAdapters，
// 不要直接 import 单个 adapter 模块。
//
// 关于凭证来源：v2.0.21 宿主实测不暴露 api.state（成员只有 options/location/app/renderer/
// client/data/attention/theme/themeMode/markdown/keymap/storage/ui），拿不到 provider 列表，
// 所以本文件不再从 api.state.provider 逐字段收窄 ProviderLike——那条路是 v2.0.21 之前的写法，
// 保留它只会让人以为宿主还有这个 API。凭证实际由 authfile.ts 从 auth.json 读出 ProviderLike[] 传入。

import { pickProvider } from "../http.js"
import type { ProviderLike, ProviderQuota } from "../types.js"
import { deepseekAdapter } from "./deepseek.js"
import { glmAdapter } from "./glm.js"
import { kimiAdapter } from "./kimi.js"
import { minimaxAdapter } from "./minimax.js"
import { openCodeGoAdapter } from "./opencode-go.js"

export type ProviderAdapter = {
  /** stable id, e.g. "glm" | "minimax" | "kimi" | "deepseek" | "opencode-go" */
  id: string
  /** display name, e.g. "GLM" | "MiniMax" | "Kimi" | "DeepSeek" | "OpenCode Go" */
  label: string
  /** does this host provider entry belong to this adapter? */
  match: (p: ProviderLike) => boolean
  /** optional tie-breaker when several entries match (prefer this one) */
  prefer?: (p: ProviderLike) => boolean
  fetch: (p: ProviderLike) => Promise<ProviderQuota>
}

export { deepseekAdapter, glmAdapter, kimiAdapter, minimaxAdapter, openCodeGoAdapter }

/** 面板展示顺序：GLM、MiniMax、Kimi、DeepSeek、OpenCode Go */
export const PROVIDERS: readonly ProviderAdapter[] = [
  glmAdapter,
  minimaxAdapter,
  kimiAdapter,
  deepseekAdapter,
  openCodeGoAdapter,
]

function nonEmpty(s: string | undefined): boolean {
  return s != null && s.trim() !== ""
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
 * 五家 adapter 现在都带兜底站点（见各自 DEFAULT_* 常量 / 固定 URL 常量），所以只要有 apiKey 就能定位接口，
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
