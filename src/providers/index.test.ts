// providers/index.ts 的测试。跑法：npm test
//
// 只测纯函数 isSupportedProviderID —— 它决定「探测到的 provider 本插件能不能查」。
// 这条判断错了的后果很具体：探测到不支持的 provider（如 Claude）却当成支持的，
// 面板就会回落到候选列表首个（GLM），拿 GLM 的额度冒充当前模型。
//
// 本文件 import providers/index.ts 会连带 import http.ts（只在真正发请求时才联网，
// import 期无副作用），不碰真凭证、不发任何网络请求。

import test from "node:test"
import assert from "node:assert/strict"

import { isSupportedProviderID } from "./index.js"

test("支持的四家 providerID 都能映射到 adapter", () => {
  assert.equal(isSupportedProviderID("minimax-cn-coding-plan"), true)
  assert.equal(isSupportedProviderID("zhipuai-coding-plan"), true)
  assert.equal(isSupportedProviderID("deepseek"), true)
  assert.equal(isSupportedProviderID("kimi-for-coding"), true)
})

test("不支持的 providerID 一律不算支持（Claude / Copilot 等）", () => {
  assert.equal(isSupportedProviderID("anthropic"), false)
  assert.equal(isSupportedProviderID("github-copilot"), false)
})

test("空 id 不算支持", () => {
  assert.equal(isSupportedProviderID(""), false)
})
