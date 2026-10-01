// DeepSeek：仅余额，无套餐窗口。
// 实测 2026-09：/user/coding_plan、/coding/v1/usages、/user/usage 全部 HTTP 404——
// DeepSeek 是纯按量付费（pay-as-you-go），没有 coding plan 也没有配额窗口接口。
// 因此「只出一个余额 extra、windows 为空」就是完整正确的实现，不要再加窗口。

import type { ProviderQuota } from "../types.js"
import { asRecord } from "./common.js"

function currencyPrefix(currency: unknown): string {
  if (currency === "CNY") return "¥"
  const c = typeof currency === "string" ? currency : ""
  return c === "" ? "" : `${c} `
}

// total_balance 是 unknown，直接 String() 会产出 [object Object]（SonarQube S4157），先验类型
function balanceText(currency: unknown, balance: unknown): string {
  if (typeof balance === "number") return `${currencyPrefix(currency)}${String(balance)}`
  if (typeof balance === "string") return `${currencyPrefix(currency)}${balance}`
  throw new Error("balance_infos.total_balance 类型异常（非 string/number）")
}

/** DeepSeek /user/balance：balance_infos[] 按 currency 取 */
export function parseDeepSeekBalance(json: unknown): ProviderQuota {
  const root = asRecord(json)
  if (!root) throw new Error("响应不是 JSON 对象")
  if (root.is_available === false) throw new Error("账号不可用")
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos.map(asRecord).filter((r) => r != null) : []
  const cny = infos.find((i) => i?.currency === "CNY") ?? infos[0]
  if (!cny) throw new Error("响应中无 balance_infos")
  return { windows: [], extras: [{ label: "余额", value: balanceText(cny.currency, cny.total_balance) }] }
}
