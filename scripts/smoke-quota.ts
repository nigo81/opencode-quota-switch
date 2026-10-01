// 数据链路冒烟测试：绕开 UI，直连真实厂商接口。
// 目的：证明「auth.json 取 key → 匹配 adapter → 拉配额 → 解析」这条路通，
// 剩下的未知就只剩 TUI 渲染层了。
import { authFileProviders, authFileTrace } from "../src/authfile.js"
import { availableAdapters, fetchQuota, PROVIDERS } from "../src/providers/index.js"
import { formatPercentage } from "../src/ui/format.js"
import type { QuotaWindow } from "../src/types.js"

const providers = authFileProviders()
console.log(`凭证来源: ${authFileTrace()}`)
console.log(`可用 adapter: ${availableAdapters(providers).map((a) => a.label).join(",") || "(无)"}`)

function line(w: QuotaWindow): string {
  if (w.unlimited === true) return `    ${w.label.padEnd(10)} ∞（不设限）`
  const pct = w.usedPct === undefined ? "（无百分比）" : `已用 ${formatPercentage(w.usedPct)}`
  const num = w.limit ? ` ${w.used ?? 0}/${w.limit}` : ""
  const reset = w.resetLabel ? ` 重置 ${w.resetLabel}` : ""
  return `    ${w.label.padEnd(10)} ${pct}${num}${reset}`
}

let fail = 0
for (const adapter of PROVIDERS) {
  if (!providers.some((p) => adapter.match(p))) {
    console.log(`\n—— ${adapter.label}: 本机没配这个 provider，跳过`)
    continue
  }
  const t0 = Date.now()
  try {
    const q = await fetchQuota(adapter, providers)
    console.log(`\n✓ ${adapter.label} (${Date.now() - t0}ms)${q.level ? `  level=${q.level}` : ""}`)
    for (const w of q.windows) console.log(line(w))
    for (const e of q.extras) console.log(`    ${e.label.padEnd(10)} ${e.value}`)
  } catch (e) {
    fail++
    console.log(`\n✗ ${adapter.label} (${Date.now() - t0}ms): ${e instanceof Error ? e.message : String(e)}`)
  }
}
console.log(`\n${fail === 0 ? "全部成功" : `${fail} 个失败`}`)
process.exit(fail === 0 ? 0 : 1)
