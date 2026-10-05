// 凭证源入口：合并两个来源，对外仍是 authFileProviders()。
//
// 1) SQLite `opencode.db` 的 `credential` 表（dbcredential.ts）—— v2 的**权威**来源。
//    TUI 的 `/connect` 在 v2 写的是这张表，不再写 auth.json；auth.json 只被一次 migration
//    读过，运行时**根本不再读**。只读 auth.json 的老实现会一直用着被 /connect 停用的旧 key
//    （面板显示旧账号额度），这是本文件要修的 bug。
// 2) auth.json —— 降级路径：1.x 宿主、干净安装、DB 读不出来/没有 credential 表时。
//
// 为什么需要这个文件：v2.0.21 宿主实测不暴露 api.state（真实成员只有
// options/location/app/renderer/client/data/attention/theme/themeMode/
// markdown/keymap/storage/ui），拿不到 provider 列表，凭证只能自己读。
// 参考项目 opencode-glm-vistatus 也是这么做的（它还停留在只读 auth.json 的阶段）。
//
// 合并规则：SQLite 优先。同一个 integration_id 两边都有时**以 SQLite 为准**——
// auth.json 里那把通常正是被 /connect 停用的旧 key，合并时覆盖它等于把 bug 留在原地。
//
// 安全边界（沿用本仓 http.ts 的纪律）：key 只在内存里传给厂商自己的配额 HTTPS 接口，
// 绝不落盘、绝不进日志、绝不进面板。日志/trace 只打 provider id 和来源 basename。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dbCredentialProviders, dbCredentialTrace, resetDbCredentialCache } from "./dbcredential.js"
import type { ProviderLike } from "./types.js"

type AuthEntry = { type?: unknown; key?: unknown }

function candidatePaths(): string[] {
  const paths = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "auth.json"),
  ]
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) paths.push(path.join(xdg, "opencode", "auth.json"))
  return paths
}

let cache: { at: number; list: ProviderLike[]; from: string } | null = null
const TTL_MS = 30_000

function readAuthFile(): { list: ProviderLike[]; from: string } {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache

  let result: { list: ProviderLike[]; from: string } = { list: [], from: "(未找到 auth.json)" }
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
      const list: ProviderLike[] = []
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as AuthEntry | null
        if (entry === null || typeof entry !== "object") continue
        // 只取 type==="api" 的条目；oauth 条目没有可直接用于配额接口的 key
        if (entry.type !== undefined && entry.type !== "api") continue
        if (typeof entry.key !== "string" || entry.key.trim() === "") continue
        list.push({ id, apiKey: entry.key })
      }
      if (list.length > 0) {
        result = { list, from: p }
        break
      }
    } catch {
      // 解析失败就当没有这个候选路径，继续试下一个
    }
  }
  cache = { at: now, ...result }
  return result
}

/**
 * 两个来源合并后的 provider 列表（只含 id + apiKey，没有 baseURL）。
 * SQLite 优先，auth.json 只补 SQLite 没提供的 integration_id。
 */
function mergedProviders(): ProviderLike[] {
  const merged: ProviderLike[] = [...dbCredentialProviders()]
  const seen = new Set(merged.map((p) => p.id))
  for (const entry of readAuthFile().list) {
    if (entry.id !== undefined) {
      // SQLite 已有同一个 integration_id：auth.json 那把通常正是被 /connect 停用的旧 key，跳过
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
    }
    merged.push(entry)
  }
  return merged
}

/** 合并后的 provider 列表（SQLite `credential` 表优先，auth.json 补空） */
export function authFileProviders(): ProviderLike[] {
  return mergedProviders()
}

/**
 * 给人看的来源摘要。**只回显 basename + driver 名 + provider id 列表**：本仓是公开插件，
 * trace 随时可能被贴进 issue，key 和绝对路径在源头就不该吐出来。
 * 格式 `来源A [ids] | 来源B [ids] → [合并后 ids]`，整串只有一个 `→`，
 * main.ts 的 authFileTraceSafe() 按第一个 `→` 切分做二次脱敏的约定不受影响。
 */
export function authFileTrace(): string {
  const { list, from } = readAuthFile()
  const merged = mergedProviders()
  return (
    `${dbCredentialTrace()} | ${path.basename(from)} ` +
    `[${list.map((p) => p.id).join(",")}] → ` +
    `[${merged.map((p) => p.id).join(",") || "(空)"}]`
  )
}

/** 测试用：清掉两个来源的 TTL 缓存 */
export function resetAuthFileCache(): void {
  cache = null
  resetDbCredentialCache()
}
