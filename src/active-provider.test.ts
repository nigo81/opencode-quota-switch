// active-provider.ts 的测试。跑法：npm test
//
// 全部用最小假 api 驱动（只认 client.session.list() 返回的会话条目），不碰真库真宿主。
// 重点验证「用户正在看的会话」的挑选规则 —— 子会话的 time_updated 总是最新，
// 不排掉它面板就会跳去子 agent 用的 provider。

import test from "node:test"
import assert from "node:assert/strict"

import { detectActiveProvider } from "./active-provider.js"

/** 本插件支持的 provider 白名单 —— 与 main.ts 里的 known 同源 */
const KNOWN = ["minimax-cn-coding-plan", "zhipuai-coding-plan", "deepseek"] as const

type SessOpts = {
  id: string
  providerID: string
  modelID?: string
  /** time 对象：宿主给的是 { created, updated, viewed }，子会话没有 viewed */
  time?: Record<string, number>
  /** 有值即子会话，落在 parentKey 指定的字段名上 */
  parent?: string
  parentKey?: "parentID" | "parent_id"
}

/**
 * 造一条会话记录。形状照宿主 v2 SDK 的 Session：
 * model 是 { id, providerID } 对象（字符串形态的 model 现层探测认不出来）。
 */
function sess(o: SessOpts): Record<string, unknown> {
  const s: Record<string, unknown> = {
    id: o.id,
    projectID: "prj_test",
    title: o.id,
    agent: "build",
    model: { id: o.modelID ?? "model-x", providerID: o.providerID },
    time: o.time ?? {},
  }
  if (o.parent !== undefined) s[o.parentKey ?? "parentID"] = o.parent
  return s
}

/** 最小假 api：只有 client.session.list()，别的层都不给内容 */
function fakeApi(list: unknown[]): unknown {
  return { client: { session: { list: async () => list } } }
}

/** 第 2 层命中时写的 note —— 用来确认命中的是哪一档 */
function listNote(notes: readonly string[]): string {
  return notes.find((n) => n.includes("client.session.list()")) ?? ""
}

// --------------------------------------------------------------------------- 子会话不参与候选

test("子会话（无 viewed、updated 最新、glm）不能抢走用户正在看的会话（viewed、minimax）", async () => {
  // 实测数据：子会话 time_viewed 为 NULL、time_updated 最新；用户会话有 viewed 但时间更早
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_user01",
        providerID: "minimax-cn-coding-plan",
        modelID: "MiniMax-M3.1-Flash",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      sess({
        id: "ses_sub001",
        providerID: "zhipuai-coding-plan",
        modelID: "glm-5.3",
        time: { created: 1500, updated: 9000 },
        parent: "ses_user01",
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(listNote(r.notes).includes("viewed"), `应命中 viewed 档: ${r.notes.join(" | ")}`)
})

test("子会话就算带更新的 viewed 时间也不参与候选", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_user01",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      sess({
        id: "ses_sub001",
        providerID: "zhipuai-coding-plan",
        time: { created: 1500, updated: 9000, viewed: 99999 },
        parent: "ses_user01",
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
})

test("parent_id 蛇形拼写同样把子会话排除掉", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_user01",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      sess({
        id: "ses_sub002",
        providerID: "zhipuai-coding-plan",
        time: { created: 1500, updated: 9999, viewed: 99999 },
        parent: "ses_user01",
        parentKey: "parent_id",
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
})

test("parentID 为 null 或空串 → 不算子会话，照常参与候选", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_user01",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      {
        id: "ses_root02",
        projectID: "prj_test",
        title: "ses_root02",
        parentID: null,
        model: { id: "glm-5.3", providerID: "zhipuai-coding-plan" },
        time: { created: 1500, updated: 9999, viewed: 99999 },
      },
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "zhipuai-coding-plan")
})

// --------------------------------------------------------------------------- 保底回落

test("所有会话都没有 viewed → 整体回落到「updated 最新」，保底行为不回归", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_old01",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000 },
      }),
      sess({
        id: "ses_new01",
        providerID: "zhipuai-coding-plan",
        time: { created: 1500, updated: 9000 },
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "zhipuai-coding-plan")
  assert.ok(listNote(r.notes).includes("兜底"), `应是兜底档: ${r.notes.join(" | ")}`)
})

test("没有 viewed 也没有 updated → 回落 created 最新", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({ id: "ses_old01", providerID: "minimax-cn-coding-plan", time: { created: 1000 } }),
      sess({ id: "ses_new01", providerID: "zhipuai-coding-plan", time: { created: 5000 } }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "zhipuai-coding-plan")
})

// --------------------------------------------------------------------------- 其它形态

test("time 是裸数字 → 当作有 viewed 等价信号，照常判出 provider", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      {
        id: "ses_user01",
        projectID: "prj_test",
        title: "ses_user01",
        model: { id: "MiniMax-M3.1-Flash", providerID: "minimax-cn-coding-plan" },
        time: 5000,
      },
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(listNote(r.notes).includes("viewed"), `应是 viewed 档: ${r.notes.join(" | ")}`)
})

test("会话列表为空 → 不报 provider，只留 notes", async () => {
  const r = await detectActiveProvider(fakeApi([]), { known: KNOWN })
  assert.equal(r.providerID, undefined)
})

// ------------------------------------------------------- 按 sessionID 精确匹配（最高优先级）

test("精确匹配压过时间排序：sessionID 指向的会话即使 viewed 更旧也选它", async () => {
  // 实测回归场景（2026-11-01 11:33）：两条 `opencode run --model deepseek/deepseek-flash`
  // 探针根会话按时间排在候选前列，面板被带成 DeepSeek；用户当前看的其实是 minimax 那条。
  // 只要宿主给了 sessionID，就必须选它 —— 时间排序猜不出「是哪个会话」。
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_probe01",
        providerID: "deepseek",
        modelID: "deepseek-flash",
        time: { created: 1000, updated: 5000, viewed: 9000 },
      }),
      sess({
        id: "ses_cur001",
        providerID: "minimax-cn-coding-plan",
        modelID: "MiniMax-M3.1-Flash",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
    ]),
    { sessionID: "ses_cur001", known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(
    r.notes.some((n) => n.includes("精确匹配")),
    `应走精确匹配层: ${r.notes.join(" | ")}`,
  )
})

test("sessionID 不在列表里 → 精确匹配未命中，回落原来的时间排序启发式", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_old01",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      sess({
        id: "ses_new01",
        providerID: "zhipuai-coding-plan",
        time: { created: 1500, updated: 9000, viewed: 9500 },
      }),
    ]),
    { sessionID: "ses_gone01", known: KNOWN },
  )
  assert.equal(r.providerID, "zhipuai-coding-plan")
  assert.ok(
    r.notes.some((n) => n.includes("精确匹配未命中")),
    `应记录精确匹配未命中: ${r.notes.join(" | ")}`,
  )
  assert.ok(listNote(r.notes).includes("viewed"), `应是 viewed 档: ${r.notes.join(" | ")}`)
})

test("精确匹配命中但会话没有 model 字段 → 不中断，继续走后面的层", async () => {
  const r = await detectActiveProvider(
    fakeApi([
      {
        id: "ses_cur001",
        projectID: "prj_test",
        title: "ses_cur001",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      },
      sess({
        id: "ses_other01",
        providerID: "zhipuai-coding-plan",
        time: { created: 1500, updated: 9000, viewed: 9500 },
      }),
    ]),
    { sessionID: "ses_cur001", known: KNOWN },
  )
  assert.ok(
    r.notes.some((n) => n.includes("精确匹配命中但没有 model 字段")),
    `应记录原因: ${r.notes.join(" | ")}`,
  )
  // 兜底层照常给出答案：另一个有 model 的会话按 viewed 档胜出
  assert.equal(r.providerID, "zhipuai-coding-plan")
})

test("精确匹配按 id 走：sessionID 指向子会话也照样命中", async () => {
  // 子会话排除规则只管「猜」的那一层（时间启发式）：id 完全对上时以宿主给的为准，
  // 用户正在看的确实是那个子会话时，它用的 provider 就该显示。
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_root01",
        providerID: "zhipuai-coding-plan",
        time: { created: 1000, updated: 9000, viewed: 9500 },
      }),
      sess({
        id: "ses_sub001",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1500, updated: 2000, viewed: 3000 },
        parent: "ses_root01",
      }),
    ]),
    { sessionID: "ses_sub001", known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
})

// ------------------------------------------- 第 1 层：api.ui.model 当前模型（最高优先级）

test("api.ui.model.current 是方法时能被正确调用（v2.2.5 宿主实现就是方法）", async () => {
  // 宿主 packages/tui/src/plugin/api.tsx v2.2.5：
  //   current() { const selection = host.local.model.selection(); if (!selection) return
  //              return { providerID: selection.providerID, modelID: selection.modelID, ... } }
  // 早期版本把它当「值」读，rec() 只接受 object → 函数被拒收 → 这一层整层空转（死代码）。
  const r = await detectActiveProvider(
    {
      ui: {
        model: { current: () => ({ providerID: "minimax-cn-coding-plan", modelID: "MiniMax-M3.1-Flash" }) },
      },
      client: { session: { list: async () => [] } },
    },
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(
    r.notes.some((n) => n.includes("api.ui.model.current()")),
    `应走方法形态: ${r.notes.join(" | ")}`,
  )
})

test("api.ui.model.current() 优先于 sessionID 精确匹配", async () => {
  // ui.model 是宿主主动告知的当前模型（与状态栏同源），比「会话里最后用过的模型」更权威
  const r = await detectActiveProvider(
    {
      ui: { model: { current: () => ({ providerID: "minimax-cn-coding-plan" }) } },
      client: {
        session: {
          list: async () => [
            sess({
              id: "ses_cur001",
              providerID: "deepseek",
              time: { created: 1000, updated: 2000, viewed: 3000 },
            }),
          ],
        },
      },
    },
    { sessionID: "ses_cur001", known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
})

test("旧代际的值形态仍能用（api.ui.model.current 是对象不是方法）", async () => {
  const r = await detectActiveProvider(
    { ui: { model: { current: { providerID: "minimax-cn-coding-plan" } } } },
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(
    r.notes.some((n) => n.includes("api.ui.model.current") && !n.includes("current()")),
    `值形态不该带括号: ${r.notes.join(" | ")}`,
  )
})

test("api.ui.model.current 抛异常 → 不炸，继续往下走", async () => {
  const r = await detectActiveProvider(
    {
      ui: {
        model: {
          current: () => {
            throw new Error("宿主内部炸了")
          },
        },
      },
      client: { session: { list: async () => [] } },
    },
    { known: KNOWN },
  )
  assert.equal(r.providerID, undefined)
})

// ------------------------------------------------- 会话列表：带 limit 调用 + 无参兜底

test("session.list 优先带 limit 调用（宿主默认只返回最新 50 条）", async () => {
  const calls: unknown[] = []
  const r = await detectActiveProvider(
    {
      ui: { model: {} },
      client: {
        session: {
          list: async (p?: unknown) => {
            calls.push(p)
            return [
              sess({
                id: "ses_cur001",
                providerID: "minimax-cn-coding-plan",
                time: { created: 1000, updated: 2000, viewed: 3000 },
              }),
            ]
          },
        },
      },
    },
    { sessionID: "ses_cur001", known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(calls.length >= 1, "应该至少调过一次 list")
  const first = calls[0] as { limit?: unknown } | undefined
  assert.equal(first?.limit, 200, `首次调用应带 limit: ${JSON.stringify(calls[0])}`)
})

test("带 limit 的 list 调用抛异常 → 退回无参调用仍能出结果", async () => {
  const calls: unknown[] = []
  const r = await detectActiveProvider(
    {
      ui: { model: {} },
      client: {
        session: {
          list: async (p?: unknown) => {
            calls.push(p)
            if (p !== undefined) throw new Error("这个宿主代际不认 limit")
            return [
              sess({
                id: "ses_cur001",
                providerID: "minimax-cn-coding-plan",
                time: { created: 1000, updated: 2000, viewed: 3000 },
              }),
            ]
          },
        },
      },
    },
    { sessionID: "ses_cur001", known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.equal(calls.length, 2, `应先带参再无参: ${JSON.stringify(calls)}`)
  assert.equal(calls[1], undefined, "第二次应是无参调用")
})

// ------------------------------------------- 排序比较器：tier1（有 viewed）必须压过 tier2

test("有 viewed 的候选压过 updated 更新的无 viewed 候选（tier 升序）", async () => {
  // 比较器曾写成 `b.tier - a.tier`（tier 降序），把「没 viewed」当成更高档，
  // 于是 updated 最大的探针会话压过用户正在看的会话，面板显示成 deepseek。
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_cur001",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 2000, viewed: 3000 },
      }),
      sess({
        id: "ses_probe01",
        providerID: "deepseek",
        time: { created: 1500, updated: 9000 },
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(listNote(r.notes).includes("viewed"), `应命中 viewed 档: ${r.notes.join(" | ")}`)
})

test("真实数据形状：多条无 viewed 的会话 updated 更新，也压不过有 viewed 的当前会话", async () => {
  // 2026-11-01 宿主 v2.2.5 的 /api/session 实测：50 条里只有 9 条带 time.viewed，
  // 没 viewed 的那些按 updated 排前面，正是把面板带偏的那一批。
  const r = await detectActiveProvider(
    fakeApi([
      sess({
        id: "ses_probeA",
        providerID: "deepseek",
        time: { created: 1000, updated: 1793504034364 },
      }),
      sess({
        id: "ses_probeB",
        providerID: "deepseek",
        time: { created: 1000, updated: 1793504011461 },
      }),
      sess({
        id: "ses_other0",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 1793202085284 },
      }),
      sess({
        id: "ses_cur001",
        providerID: "minimax-cn-coding-plan",
        time: { created: 1000, updated: 1793197994690, viewed: 1793505790938 },
      }),
    ]),
    { known: KNOWN },
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(listNote(r.notes).includes("viewed"), `应命中 viewed 档: ${r.notes.join(" | ")}`)
})
