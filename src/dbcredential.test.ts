// dbcredential.ts / authfile.ts 的测试。跑法：npm test
//
// 全部用注入的假 opener 驱动（只认行集，不碰真库），只有最后一个测试用 node:sqlite
// 建一个真库做端到端往返 —— 因为它验的是「SQL 和列名对不对」，假 opener 验不到那层。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { authFileProviders, authFileTrace, resetAuthFileCache } from "./authfile.js"
import {
  __setSqliteOpener,
  dbCredentialProviders,
  dbCredentialTrace,
  resetDbCredentialCache,
} from "./dbcredential.js"
import type { SqliteOpener } from "./dbcredential.js"

type Row = { integration_id?: unknown; value?: unknown; active?: unknown; time_updated?: unknown }

/** credential 表的一行：value 是明文 JSON 字符串 */
function row(
  integrationId: string,
  key: string,
  active: 1 | 0 | null,
  timeUpdated = 1,
  type = "key",
): Row {
  return { integration_id: integrationId, value: JSON.stringify({ type, key }), active, time_updated: timeUpdated }
}

/** 假 opener：返回固定行集，把 open/close 记进 log 供断言 */
function fakeOpener(rows: readonly unknown[], log: string[] = []): SqliteOpener {
  return (file) => {
    log.push(`open:${path.basename(file)}`)
    return {
      prepare: () => ({ all: () => rows }),
      close: () => {
        log.push("close")
      },
    }
  }
}

function opencodeDir(home: string): string {
  const dir = path.join(home, ".local", "share", "opencode")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeAuthJson(home: string, obj: unknown): void {
  fs.writeFileSync(path.join(opencodeDir(home), "auth.json"), JSON.stringify(obj))
}

/** 造一个存在的 opencode.db。内容不重要——假 opener 不读它，只认「文件存在」 */
function touchDb(home: string): string {
  const file = path.join(opencodeDir(home), "opencode.db")
  fs.writeFileSync(file, "")
  return file
}

/** 把 HOME 指向临时目录，跑完复原。两个来源的候选路径都在调用时算 os.homedir()，所以改 HOME 即刻生效 */
function withHome(run: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quota-switch-test-"))
  const prevHome = process.env.HOME
  const prevXdg = process.env.XDG_DATA_HOME
  process.env.HOME = home
  delete process.env.XDG_DATA_HOME
  resetAuthFileCache()
  try {
    run(home)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    __setSqliteOpener(undefined)
    resetAuthFileCache()
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function byId(list: readonly { id?: string; apiKey?: string }[]): Record<string, string | undefined> {
  return Object.fromEntries(list.map((p) => [p.id ?? "", p.apiKey]))
}

// --------------------------------------------------------------------------- active 选择规则

test("同一 integration_id 有 active=0 和 active=1 两行 → 取 active=1 的 key", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([
        row("minimax-cn-coding-plan", "OLD", 0, 100),
        row("minimax-cn-coding-plan", "NEW", 1, 200),
      ]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), { "minimax-cn-coding-plan": "NEW" })
  })
})

test("只有 active=NULL 的行（从 auth.json 迁移来的老凭证）→ 能取到", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([row("zhipuai-coding-plan", "MIG", null), row("kimi-for-coding", "MIG2", null)]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), {
      "zhipuai-coding-plan": "MIG",
      "kimi-for-coding": "MIG2",
    })
  })
})

test("只剩 active=0（已被新凭证取代）→ 整条忽略，不去打配额接口", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(fakeOpener([row("minimax-cn-coding-plan", "OLD", 0)]))
    assert.deepEqual(dbCredentialProviders(), [])
  })
})

test("同档位多行 → 取 time_updated 最大的那条", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([
        row("deepseek", "MID", 1, 300),
        row("deepseek", "LATEST", 1, 900),
        row("deepseek", "OLDEST", 1, 100),
      ]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), { deepseek: "LATEST" })
  })
})

// --------------------------------------------------------------------------- 逐行容错

test("value 不是合法 JSON → 只跳过该行，同表其它行不受影响", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([
        { integration_id: "deepseek", value: "{不是 JSON", active: 1, time_updated: 1 },
        row("kimi-for-coding", "GOOD", null),
      ]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), { "kimi-for-coding": "GOOD" })
  })
})

test("type 不是 key（如 oauth）→ 跳过", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([
        row("kimi-for-coding", "OAUTH-TOKEN", 1, 1, "oauth"),
        row("deepseek", "REALKEY", 1, 1, "key"),
      ]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), { deepseek: "REALKEY" })
  })
})

test("key 为空/空白，或 integration_id 缺失 → 跳过", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(
      fakeOpener([
        { integration_id: "a", value: JSON.stringify({ type: "key", key: "  " }), active: 1 },
        { integration_id: "  ", value: JSON.stringify({ type: "key", key: "X" }), active: 1 },
        { value: JSON.stringify({ type: "key", key: "X" }), active: 1 },
        row("b", "", 1),
        row("c", "KEEP", 1),
      ]),
    )
    assert.deepEqual(byId(dbCredentialProviders()), { c: "KEEP" })
  })
})

// --------------------------------------------------------------------------- 降级路径

test("DB 文件不存在 → 走 auth.json 降级", () => {
  withHome((home) => {
    writeAuthJson(home, { "zhipuai-coding-plan": { type: "api", key: "FROM-AUTHJSON" } })
    __setSqliteOpener(fakeOpener([row("deepseek", "NEVER", 1)]))
    assert.deepEqual(byId(authFileProviders()), { "zhipuai-coding-plan": "FROM-AUTHJSON" })
  })
})

test("没有 credential 表（查询抛错）→ 静默降级到 auth.json，不抛错", () => {
  withHome((home) => {
    touchDb(home)
    writeAuthJson(home, { "zhipuai-coding-plan": { type: "api", key: "FROM-AUTHJSON" } })
    const log: string[] = []
    __setSqliteOpener(() => {
      log.push("open")
      return {
        prepare: () => ({
          all: () => {
            throw new Error("no such table: credential")
          },
        }),
        close: () => {
          log.push("close")
        },
      }
    })
    assert.deepEqual(byId(authFileProviders()), { "zhipuai-coding-plan": "FROM-AUTHJSON" })
    // 抛错也必须关句柄：8GB 的库不能靠 GC
    assert.deepEqual(log, ["open", "close"])
  })
})

test("打开 DB 失败 → 静默降级，不抛错", () => {
  withHome((home) => {
    touchDb(home)
    writeAuthJson(home, { deepseek: { type: "api", key: "FROM-AUTHJSON" } })
    __setSqliteOpener(() => {
      throw new Error("unable to open database file")
    })
    assert.deepEqual(byId(authFileProviders()), { deepseek: "FROM-AUTHJSON" })
  })
})

test("bun:sqlite 形态（只有 query()，没有 prepare()）也能读", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(() => ({ query: () => ({ all: () => [row("deepseek", "BUNKEY", 1)] }), close: () => {} }))
    assert.deepEqual(byId(dbCredentialProviders()), { deepseek: "BUNKEY" })
  })
})

// --------------------------------------------------------------------------- 合并规则

test("SQLite 与 auth.json 都有同一 provider → SQLite 胜出（auth.json 那把是被 /connect 停用的旧 key）", () => {
  withHome((home) => {
    touchDb(home)
    writeAuthJson(home, {
      "minimax-cn-coding-plan": { type: "api", key: "STALE-AUTHJSON-KEY" },
      "zhipuai-coding-plan": { type: "api", key: "ONLY-IN-AUTHJSON" },
    })
    __setSqliteOpener(fakeOpener([row("minimax-cn-coding-plan", "FRESH-DB-KEY", 1)]))
    assert.deepEqual(byId(authFileProviders()), {
      "minimax-cn-coding-plan": "FRESH-DB-KEY",
      "zhipuai-coding-plan": "ONLY-IN-AUTHJSON",
    })
  })
})

test("合并进 availableAdapters()：credential 表的 integration_id 能被 adapter match 认领", () => {
  withHome((home) => {
    touchDb(home)
    __setSqliteOpener(fakeOpener([row("minimax-cn-coding-plan", "KEY", 1), row("deepseek", "KEY2", 1)]))
    const ids = authFileProviders().map((p) => p.id)
    assert.deepEqual(ids, ["minimax-cn-coding-plan", "deepseek"])
  })
})

// --------------------------------------------------------------------------- 生命周期与安全

test("TTL 窗口内不重复开库（面板每 3s 探一次，不能每 3s 重开一次库）", () => {
  withHome((home) => {
    touchDb(home)
    const log: string[] = []
    __setSqliteOpener(fakeOpener([row("deepseek", "KEY", 1)], log))
    dbCredentialProviders()
    dbCredentialProviders()
    dbCredentialProviders()
    assert.equal(log.filter((l) => l.startsWith("open:")).length, 1)
    assert.equal(log.filter((l) => l === "close").length, 1)
    resetDbCredentialCache()
    dbCredentialProviders()
    assert.equal(log.filter((l) => l.startsWith("open:")).length, 2)
  })
})

test("trace 只回显来源 basename、driver 名和 integration_id —— 不含 key、不含绝对路径", () => {
  withHome((home) => {
    touchDb(home)
    writeAuthJson(home, { "zhipuai-coding-plan": { type: "api", key: "SUPER-SECRET-KEY" } })
    __setSqliteOpener(fakeOpener([row("deepseek", "DB-SECRET-KEY", 1)]))
    for (const text of [dbCredentialTrace(), authFileTrace()]) {
      assert.ok(text.includes("deepseek"))
      assert.ok(!text.includes("DB-SECRET-KEY"))
      assert.ok(!text.includes("SUPER-SECRET-KEY"))
      assert.ok(!text.includes(home), `trace 泄露了绝对路径: ${text}`)
      assert.ok(!text.includes(os.homedir()))
    }
  })
})

// --------------------------------------------------------------------------- 真库往返

test("真实 SQLite 往返：列名/active 规则对得上，且只读打开不写盘（node:sqlite 不可用则跳过）", async (t) => {
  let Ctor: new (f: string, o?: unknown) => { exec: (sql: string) => void; close: () => void; prepare: (sql: string) => { run: (...args: unknown[]) => void } }
  try {
    const mod = (await import("node:" + "sqlite")) as Record<string, unknown>
    if (typeof mod.DatabaseSync !== "function") {
      t.skip("node:sqlite 不可用")
      return
    }
    Ctor = mod.DatabaseSync as unknown as typeof Ctor
  } catch {
    t.skip("node:sqlite 不可用")
    return
  }

  withHome((home) => {
    const file = touchDb(home)
    const w = new Ctor(file)
    w.exec(
      "CREATE TABLE `credential` (" +
        "`id` text PRIMARY KEY, `integration_id` text, `label` text NOT NULL, `value` text NOT NULL, " +
        "`connector_id` text, `method_id` text, `active` integer, " +
        "`time_created` integer NOT NULL, `time_updated` integer NOT NULL)",
    )
    const ins = w.prepare(
      "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?,?,?,?,?,?,?)",
    )
    ins.run("a", "minimax-cn-coding-plan", "old", JSON.stringify({ type: "key", key: "OLD" }), 0, 1, 100)
    ins.run("b", "minimax-cn-coding-plan", "new", JSON.stringify({ type: "key", key: "NEW" }), 1, 1, 200)
    ins.run("c", "zhipuai-coding-plan", "migrated", JSON.stringify({ type: "key", key: "MIG" }), null, 1, 100)
    ins.run("d", "kimi-for-coding", "oauth", JSON.stringify({ type: "oauth", token: "OAUTH" }), 1, 1, 100)
    ins.run("e", "deepseek", "broken", "{不是 JSON", 1, 1, 100)
    w.close()

    const before = fs.statSync(file)
    __setSqliteOpener(undefined) // 走生产路径：真实 driver + 只读打开
    resetDbCredentialCache()
    const got = byId(dbCredentialProviders())
    assert.deepEqual(got, {
      "minimax-cn-coding-plan": "NEW",
      "zhipuai-coding-plan": "MIG",
    })

    const after = fs.statSync(file)
    assert.equal(after.size, before.size, "只读打开却改了库大小")
    assert.equal(after.mtimeMs, before.mtimeMs, "只读打开却改了 mtime")
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.equal(fs.existsSync(file + suffix), false, `只读打开却创建了 ${suffix}`)
    }
  })
})
