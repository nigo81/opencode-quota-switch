// 兜底凭证源：从 OpenCode 自己的 auth.json 读 provider 的 apiKey。
//
// 为什么需要：v2.0.21 宿主实测不暴露 api.state（真实成员只有
// options/location/app/renderer/client/data/attention/theme/themeMode/
// markdown/keymap/storage/ui），拿不到 provider 列表，而凭证只在 provider 列表里。
// 参考项目 opencode-glm-vistatus 也是这么做的。
//
// 安全边界（沿用本仓 http.ts 的纪律）：key 只在内存里传给厂商自己的配额 HTTPS 接口，
// 绝不落盘、绝不进日志、绝不进面板。日志只打 provider id。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

/** auth.json 里的 provider 列表（只含 id + apiKey，没有 baseURL） */
export function authFileProviders(): ProviderLike[] {
  return readAuthFile().list
}

/** 供 trace 用：只回显候选文件名与 provider id 列表，绝不回显 key */
export function authFileTrace(): string {
  const { list, from } = readAuthFile()
  return `${from} → [${list.map((p) => p.id).join(",") || "(空)"}]`
}

/** 测试用：清掉 TTL 缓存 */
export function resetAuthFileCache(): void {
  cache = null
}
