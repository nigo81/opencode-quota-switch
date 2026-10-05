// 权威凭证源：OpenCode 2.x 把 `/connect` 拿到的凭证写进 SQLite `opencode.db` 的 `credential` 表。
//
// 为什么必须是它（v2.0.22 实测）：TUI 的 `/connect` **不再写 auth.json**，v2 里 auth.json 只被
// 一次 migration 读过一次，运行时**根本不再读**。只读 auth.json 的老实现会一直用着被 `/connect`
// 停用的旧 key —— 面板显示的是旧账号额度，这就是本文件要修的 bug。
// auth.json 保留为降级路径（1.x 宿主 / 干净安装 / DB 读不出来时）。
//
// 表结构（实测）：
//   id TEXT PK / integration_id TEXT / label TEXT NOT NULL / value TEXT NOT NULL
//   connector_id TEXT / method_id TEXT / active INTEGER
//   time_created INTEGER NOT NULL / time_updated INTEGER NOT NULL
// `value` 是**明文 JSON**（不是加密），形如 {"type":"key","key":"sk-..."}，直接 parse 取 key。
//
// `active` 语义（实测数据）：
//   1    = 当前生效的那条
//   0    = 被新凭证取代，已停用（实测 minimax 老 key 就是 0，新 key 是 1）
//   NULL = 从 auth.json 迁移来的老凭证，没有 active 标记（实测 zhipuai / kimi 都是 NULL）
//
// 安全边界（沿用本仓 authfile.ts / http.ts 的纪律）：DB 一律**只读**打开，key 只在内存里传给
// 厂商自己的配额 HTTPS 接口，绝不落盘、绝不写回 DB、绝不进日志/trace/面板。
// trace 只回显 integration_id、来源 basename 和 driver 名 —— 本仓是公开插件，
// trace 随时可能被贴进 issue，所以连绝对路径都不吐（见 authFileTrace 的调用点）。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import type { ProviderLike } from "./types.js"

/**
 * driver 模块名用变量拼，且 import 保持动态。
 * 宿主 `bin/opencode.exe` 是 bun 打包的 Mach-O（头部含 `bun\x00`），但头部既不含
 * `node:sqlite` 也不含 `bun:sqlite` 字面量，静态判断不了插件实际跑在哪个 runtime；
 * 两种 runtime 各自的开库类名也不同（`DatabaseSync` vs `Database`），只能两个都试。
 *
 * 拼变量不是为了骗 esbuild：产物是 esm（format:"esm"），动态 import 本来就不会被改写成
 * require，而 `node:*` 在 build.mjs 的 external 里，所以拼不拼都是「运行时解析」。
 * 写变量只是让「这两个模块名不该被静态依赖」这件事在代码里自明。
 */
const NODE_SPEC = "node:" + "sqlite"
const BUN_SPEC = "bun:" + "sqlite"

const SQL = "SELECT `integration_id`, `value`, `active`, `time_updated` FROM `credential`"

/** 缓存窗口，与 authfile.ts 的 TTL_MS 保持一致：面板每 3s 探一次 provider，DB 有 8GB，不能每 3s 重开一次库 */
const TTL_MS = 30_000

/** 只读句柄的最小形状：`node:sqlite` 的 DatabaseSync 与 `bun:sqlite` 的 Database 都满足 */
export type SqliteHandle = {
  /** node:sqlite 走 prepare */
  prepare?: (sql: string) => { all: () => unknown }
  /** bun:sqlite 走 query */
  query?: (sql: string) => { all: () => unknown }
  close: () => void
}

/** 打开函数。生产走已解析出的 driver；测试用 __setSqliteOpener 换成假的 */
export type SqliteOpener = (file: string) => SqliteHandle

type Driver = {
  /** 只进 trace，不含任何机密 */
  name: string
  open: SqliteOpener
}

export type DbCredentialSource = {
  /** 从 credential 表造出来的 provider 条目（id = integration_id） */
  list: ProviderLike[]
  /** 人类可读的来源标签，**只有 basename**，绝不含绝对路径 */
  from: string
  /** 实际生效的 driver 名；测试注入的打开函数记 "test" */
  runtime: string
}

function candidateDbPaths(): string[] {
  const paths = [
    path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    path.join(os.homedir(), ".config", "opencode", "opencode.db"),
  ]
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) paths.push(path.join(xdg, "opencode", "opencode.db"))
  return paths
}

// --------------------------------------------------------------------------- driver 解析

function ctorOf(mod: unknown, name: string): (new (f: string, o?: unknown) => SqliteHandle) | null {
  if (mod === null || typeof mod !== "object") return null
  const ctor = (mod as Record<string, unknown>)[name]
  return typeof ctor === "function" ? (ctor as new (f: string, o?: unknown) => SqliteHandle) : null
}

function nodeDriver(mod: unknown): Driver | null {
  const Ctor = ctorOf(mod, "DatabaseSync")
  if (!Ctor) return null
  return {
    name: NODE_SPEC,
    // readOnly:true —— 硬件级只读：连「打开时建 WAL / 建 journal」都不会发生
    open: (file) => new Ctor(file, { readOnly: true }),
  }
}

function bunDriver(mod: unknown): Driver | null {
  const Ctor = ctorOf(mod, "Database")
  if (!Ctor) return null
  return {
    name: BUN_SPEC,
    // bun 的开关拼作 readonly（比 node 少个 R）；create:false 再兜一层「文件不存在就别建」
    open: (file) => new Ctor(file, { readonly: true, create: false }),
  }
}

/** 同步路径：createRequire 让 ESM 里能同步 require（builtin），只读读库必须是同步的 */
function probeSync(): Driver | null {
  try {
    const req = createRequire(import.meta.url)
    for (const [spec, build] of [
      [NODE_SPEC, nodeDriver],
      [BUN_SPEC, bunDriver],
    ] as const) {
      let mod: unknown
      try {
        mod = req(spec)
      } catch {
        continue // 这个 runtime 没有这个模块，吞掉试下一个
      }
      const driver = build(mod)
      if (driver) return driver
    }
    return null
  } catch {
    // createRequire 本身不可用（极老的宿主 / 沙箱），静默降级到动态 import
    return null
  }
}

/** 动态 import 路径：node:sqlite 未必能在 require 形态下拿到，两个都兜一遍 */
async function probeAsync(): Promise<Driver | null> {
  for (const [spec, build] of [
    [NODE_SPEC, nodeDriver],
    [BUN_SPEC, bunDriver],
  ] as const) {
    try {
      const driver = build(await import(spec))
      if (driver) return driver
    } catch {
      // 模块不存在 / 被 runtime 禁用，试下一个
    }
  }
  return null
}

let driverSync: Driver | null | undefined
let driverAsync: Driver | null | undefined

/** 同步拿到就用同步那条；同步拿不到时，靠模块加载时就 arm 起来的动态 import 补位 */
function activeDriver(): Driver | null {
  if (driverSync === undefined) {
    driverSync = probeSync()
    if (driverSync === null) armAsyncProbe()
  }
  return driverSync ?? driverAsync ?? null
}

/** 同步探测失败时才 arm：预热成功就把之前「没 driver」缓存的空结果丢掉，别让它白等满 30s */
function armAsyncProbe(): void {
  if (driverAsync !== undefined) return
  void probeAsync()
    .then((d) => {
      driverAsync = d
      if (d) cache = null
    })
    .catch(() => {
      driverAsync = null
    })
}

// --------------------------------------------------------------------------- 行 → ProviderLike

/** active 列归一：SQLite INTEGER → 1 / 0 / NULL，容忍 driver 返回字符串数字 */
function normalizeActive(v: unknown): 1 | 0 | null {
  if (v === null || v === undefined) return null
  if (v === 1 || v === "1") return 1
  if (v === 0 || v === "0") return 0
  return null
}

/**
 * 取 credential 行里的裸 key，取不到就 undefined。
 * 两个必须跳过的形态：`type !== "key"`（oauth 凭证没有可直接用的裸 key）、value 不是合法 JSON
 * （迁移来的老数据或半截写入）。**单行解析失败只丢这一行，不影响同一 integration_id 的其它行。**
 */
function parseKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const rec = parsed as Record<string, unknown>
  if (rec.type !== "key") return undefined
  const key = rec.key
  if (typeof key !== "string" || key.trim() === "") return undefined
  return key
}

/**
 * 同一 integration_id 多行时的选择规则，**在 JS 里排而不是交给 SQL**：
 * SQL 的 `ORDER BY (active IS NULL) ASC, active DESC` 会把 active=0 排在 NULL 前面，
 * 而 active=0 的语义是「已被新凭证取代」，本来就不该被选中，写进 ORDER BY 只会让
 * 「排除它」这条规则变绕。规则本身：
 *   active=1        优先（当前生效）
 *   active IS NULL  次之（从 auth.json 迁移来的老凭证，没有 active 标记）
 *   active=0        整条忽略（已停用）
 * 同档位内取 time_updated 最大的那条。
 */
function selectRows(rows: readonly unknown[]): ProviderLike[] {
  const best = new Map<string, { rank: number; updated: number; entry: ProviderLike }>()
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
    const row = raw as { integration_id?: unknown; value?: unknown; active?: unknown; time_updated?: unknown }
    const active = normalizeActive(row.active)
    if (active === 0) continue
    const id = typeof row.integration_id === "string" ? row.integration_id.trim() : ""
    if (id === "") continue
    const key = parseKey(row.value)
    if (key === undefined) continue
    const rank = active === 1 ? 0 : 1
    const updated = typeof row.time_updated === "number" ? row.time_updated : 0
    const prev = best.get(id)
    if (!prev || rank < prev.rank || (rank === prev.rank && updated > prev.updated)) {
      best.set(id, { rank, updated, entry: { id, apiKey: key } })
    }
  }
  return [...best.values()].map((v) => v.entry)
}

// --------------------------------------------------------------------------- 读库

function queryAll(handle: SqliteHandle): unknown[] | undefined {
  try {
    // node:sqlite 是 prepare()，bun:sqlite 是 query()，两个 driver 只需要认一个
    const stmt = handle.prepare?.(SQL) ?? handle.query?.(SQL)
    if (!stmt || typeof stmt.all !== "function") return undefined
    const rows = stmt.all()
    return Array.isArray(rows) ? rows : undefined
  } catch {
    // 没有 credential 表 / SQL 失败 / DB 被锁：都归到「这条路走不通」，静默降级
    return undefined
  }
}

let openFn: SqliteOpener | undefined

/** 生产用的打开函数：注入的优先，否则用已解析出的 driver */
function defaultOpener(): SqliteOpener | undefined {
  if (openFn) return openFn
  return activeDriver()?.open
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function load(): DbCredentialSource {
  const opener = defaultOpener()
  if (!opener) return { list: [], from: "(无可用 SQLite runtime)", runtime: "none" }
  const file = candidateDbPaths().find(fileExists)
  if (file === undefined) return { list: [], from: "(未找到 opencode.db)", runtime: runtimeName() }
  let handle: SqliteHandle
  try {
    handle = opener(file)
  } catch {
    return { list: [], from: "opencode.db(打开失败)", runtime: runtimeName() }
  }
  try {
    const rows = queryAll(handle)
    if (rows === undefined) return { list: [], from: "opencode.db(无 credential 表)", runtime: runtimeName() }
    return { list: selectRows(rows), from: "opencode.db", runtime: runtimeName() }
  } catch {
    return { list: [], from: "opencode.db(读取失败)", runtime: runtimeName() }
  } finally {
    // 用完立刻关：8GB 的库不能靠 GC 回收句柄
    try {
      handle.close()
    } catch {
      /* 关不掉也不该因此打断面板 */
    }
  }
}

function runtimeName(): string {
  return openFn ? "test" : (activeDriver()?.name ?? "none")
}

let cache: ({ at: number } & DbCredentialSource) | null = null

function readDb(): DbCredentialSource {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache
  const result = load()
  cache = { at: now, ...result }
  return result
}

// --------------------------------------------------------------------------- 对外

/**
 * 从 SQLite credential 表造出的 ProviderLike[]（id = integration_id，apiKey = value.key）。
 * 同步返回：面板每 3s 探一次 provider，调用方（authFileProviders / main.ts）是同步链路。
 * 读不出来一律返回空数组，绝不抛错打断面板（1.x 宿主、干净安装都必须能正常跑）。
 */
export function dbCredentialProviders(): ProviderLike[] {
  return readDb().list
}

/** 供 trace 用：只回显来源 basename、driver 名和 integration_id 列表，绝不回显 key、绝不吐绝对路径 */
export function dbCredentialTrace(): string {
  const { list, from, runtime } = readDb()
  return `${from}(${runtime}) [${list.map((p) => p.id ?? "?").join(",")}]`
}

/** 测试用：清掉 TTL 缓存 */
export function resetDbCredentialCache(): void {
  cache = null
}

/**
 * 测试用：替换打开函数。传 undefined 恢复生产路径（用已解析出的 driver）。
 * 刻意做成模块内可替换的函数而不是全局单例注入——生产路径就是「找到 driver 就开」这一条直线。
 */
export function __setSqliteOpener(fn: SqliteOpener | undefined): void {
  openFn = fn
  cache = null
}
