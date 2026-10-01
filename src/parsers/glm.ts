// 智谱 GLM Coding Plan：/api/monitor/usage/quota/limit
// 逻辑逐行等价于上游 opencode-quota-usage@0.3.7 的 GLM 分支，仅拆分为独立模块。
//
// 本接口的三个字段坑（照抄上游 + 本仓 2026-10 复核）：
//
// 1. percentage 是「已用百分比」，量纲 0-100，**向下取整**——这一条是实测确证的，不是猜的。
//    交叉验证样本（本机账号 2026-10-01 真实响应里唯一同时给齐三个字段的一行）：
//      type=TIME_LIMIT  usage=4000  currentValue=1191  percentage=29
//      currentValue/usage*100 = 29.775  →  percentage = floor(29.775) = 29
//    若量纲是 0-1 比例，这里该是 0.29775、面板会显 0.2%，与实际观察到的 29% 矛盾，故排除比例制。
//    未覆盖的部分要说清楚：同响应里的 5h/周 两行是 TOKENS_LIMIT，接口不返回 usage/currentValue，
//    无法交叉验证，只能靠上面这一行 + UI 侧 formatPercentage() 不做 ×100 的硬约束反推。
//    推论（同样未确证）：既然是向下取整，TOKENS_LIMIT 行的 percentage 正常情况下不会 >100；
//    面板仍见过 140，说明那多半是 usage/currentValue/percentage 三者取自不同快照的时刻，
//    而不是「厂商把比例当成百分数」。所以下面按「越界就 clamp」处理，不做 ×100 之类的猜测性换算。
//    若将来确证是比例制，只改这一处，别散落到别处。
// 2. percentage 会越界：实测见过 140。透传会让面板显示 "140%"，破坏 types.ts 的 usedPct 0-100
//    契约，故必须 clamp。布局不会破（panel.tsx 的 barWidth/barFits 与 pctPad 用同一表达式自适应），
//    但数字难看且越界。
// 3. nextResetTime 实测是毫秒时间戳（number），但同为 ISO 的先例存在（Kimi 的 resetTime 带纳秒），
//    且 5h 重置瞬间会整个缺失。排序键与展示标签统一走 timeToMs 归一：toNum 遇 ISO 返回 undefined，
//    两侧都落 MAX_SAFE_INTEGER，排序会静默退化成数组原序（错但不报错，最难发现的一类 bug）。
//
// 窗口标签：实测新套餐恒两个窗口，5h = unit3/number5、周 = unit6/number1。
// 厂商一旦加第三个窗口（比如月），靠「识别不出来就都叫周」的兜底会让面板出现两行一模一样的
// 「周」——那比显示一个中性名字糟糕得多，因为用户无从分辨。故未知组合走「窗口N」+ 重名加后缀。

import type { ProviderQuota, QuotaWindow } from "../types.js"
import { asRecord, formatReset, limitsOf, pctOf, sortByDisplayOrder, strField, timeToMs, toNum } from "./common.js"

function glmWindowRow(l: Record<string, unknown> | undefined, label: string): QuotaWindow {
  const total = toNum(l?.usage)
  const used = toNum(l?.currentValue)
  // 坑 2：接口直给的 percentage 要 clamp；pctOf 兜底自己已经 clamp，只管这一支
  const rawPct = toNum(l?.percentage)
  return {
    label,
    usedPct: rawPct == null ? pctOf(used, total) : Math.max(0, Math.min(100, rawPct)),
    used,
    limit: total,
    resetLabel: formatReset(l?.nextResetTime),
  }
}

// 排序后首条=5h（重置更早）、次条=周；单条视为老套餐仅 5h 额度
function glmLegacyLabel(count: number, index: number): string {
  if (count <= 1) return "额度"
  if (index === 0) return "5h"
  return "周"
}

// 新套餐实测：5h 窗口恒为 unit=3/number=5，周窗口恒为 unit=6/number=1。
// 5h 重置瞬间 nextResetTime 可能缺失，按重置时间排序会错位标签（实证事故），必须用字段直接判定。
//
// 未知组合的取舍：老写法是「unit 和 number 都在就一律叫周」，那实际上是把「没认出来」冒充成
// 「认出来了」——厂商加月窗口时（实测 (3,1) 就会落进来），面板会出现两行一样的「周」，
// 用户既不知道多了一个窗口，也分不清两行谁是谁。改为按 number 造中性标签「窗口N」：
// 名字未必好看，但互不相同、可辨认，信息量是「有个 N 单位的窗口，周期没认出来」而不是假的确定。
//
// number 也缺失时才回落位置推断的标签（保老行为）。注意这条兜底**未实测**：
// 本机账号的 TOKENS_LIMIT 行是带 unit/number 的（3/5、6/1），只是缺 usage/currentValue；
// unit/number 双双不存在的响应长什么样还没见过。这里保留它是因为它是无害的纯回退，
// 真出现了也比返回一个中性标签更接近历史行为。
function glmCreditLabel(l: Record<string, unknown> | undefined, fallback: string): string {
  const unit = toNum(l?.unit)
  const number = toNum(l?.number)
  if (unit === 3 && number === 5) return "5h"
  if (unit === 6 && number === 1) return "周"
  if (number != null) return `窗口${number}`
  return fallback
}

// 面板一行一窗口，标签重名用户就没法分辨了。按最终展示顺序给重名加序号后缀（周 → 周2）。
// 必须在 sortByDisplayOrder 之后做：先排完序，才能保证先出现的那行保住干净标签、后缀往后排。
//
// 后缀对「以数字结尾」的标签要换分隔符：中性标签本身就是「窗口1」，直接接数字会得到「窗口12」，
// 读起来像「12 号窗口」而不是「第 2 个 1 单位窗口」——那等于用一处歧义换另一处。
function dedupeLabels(windows: QuotaWindow[]): QuotaWindow[] {
  const seen = new Set<string>()
  const suffixed = (base: string, n: number): string => (/\d$/.test(base) ? `${base}#${n}` : `${base}${n}`)
  for (const w of windows) {
    if (!seen.has(w.label)) {
      seen.add(w.label)
      continue
    }
    let n = 2
    while (seen.has(suffixed(w.label, n))) n++
    w.label = suffixed(w.label, n)
    seen.add(w.label)
  }
  return windows
}

function glmWindows(data: Record<string, unknown>): QuotaWindow[] {
  const rawLimits = limitsOf(data)
  const windows: QuotaWindow[] = []
  // type 实测两种都出现过，字段组合**按 type 走、不统一**（本机账号 2026-10-01 真实响应）：
  //   TOKENS_LIMIT：5h(unit3/number5) 与 周(unit6/number1)，只给 percentage，不给 usage/currentValue
  //                  → 面板退化成纯百分比行（无 used/limit），这也是 pctOf 兜底在这两条上永不触发的原因
  //   CREDIT_LIMIT：社区脚本按 usage/currentValue/percentage 处理
  //   TIME_LIMIT：给全 usage/currentValue/percentage（就是面板上的 MCP 行）
  // 两种都收，标签逻辑只看 unit/number、与 type 无关，所以加了月窗口也不会因为 type 不同而漏判。
  const tokenLike = rawLimits.filter((l) => l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT")
  // 坑 3：排序键走 timeToMs 而不是 toNum —— toNum 遇到 ISO 字符串返回 undefined，
  // 两侧都落 MAX_SAFE_INTEGER，排序静默退化成数组原序（行序错但不报错，最难发现的一类 bug）。
  const sorted = [...tokenLike].sort(
    (a, b) => (timeToMs(a?.nextResetTime) ?? Number.MAX_SAFE_INTEGER) - (timeToMs(b?.nextResetTime) ?? Number.MAX_SAFE_INTEGER),
  )
  sorted.forEach((l, i) => {
    windows.push(glmWindowRow(l, glmCreditLabel(l, glmLegacyLabel(sorted.length, i))))
  })
  const mcp = rawLimits.find((l) => l?.type === "TIME_LIMIT")
  if (mcp) windows.push(glmWindowRow(mcp, "MCP"))
  return dedupeLabels(sortByDisplayOrder(windows))
}

/** 智谱 GLM Coding Plan /api/monitor/usage/quota/limit */
export function parseGlmQuota(json: unknown): ProviderQuota {
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  if (root.success === false) throw new Error(strField(root, "msg") ?? "接口返回失败")
  const data = asRecord(root.data) ?? root
  const windows = glmWindows(data)
  if (!windows.length) throw new Error("响应中无 TOKENS_LIMIT/CREDIT_LIMIT 窗口")
  return { level: strField(data, "level"), windows, extras: [] }
}
