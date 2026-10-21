// active-provider.ts 的测试。跑法：npm test
//
// 全部用最小假 api 驱动（只认 client.session.list() 返回的会话条目），不碰真库真宿主。
// 重点验证「用户正在看的会话」的挑选规则 —— 子会话的 time_updated 总是最新，
// 不排掉它面板就会跳去子 agent 用的 provider。

import test from "node:test"
import assert from "node:assert/strict"

import { detectActiveProvider } from "./active-provider.js"

/** 本插件支持的 provider 白名单 —— 与 main.ts 里的 known 同源 */
const KNOWN = ["minimax-cn-coding-plan", "zhipuai-coding-plan"] as const

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
    [],
    KNOWN,
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
    [],
    KNOWN,
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
    [],
    KNOWN,
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
    [],
    KNOWN,
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
    [],
    KNOWN,
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
    [],
    KNOWN,
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
    [],
    KNOWN,
  )
  assert.equal(r.providerID, "minimax-cn-coding-plan")
  assert.ok(listNote(r.notes).includes("viewed"), `应是 viewed 档: ${r.notes.join(" | ")}`)
})

test("会话列表为空 → 不报 provider，只留 notes", async () => {
  const r = await detectActiveProvider(fakeApi([]), [], KNOWN)
  assert.equal(r.providerID, undefined)
})
