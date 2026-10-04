/**
 * api.kv 适配层：宿主 v2.0.22 把 api.kv 删了，换成了 api.storage（成员 store/memory）。
 * 1.15.10 的类型包没有 storage 声明，只能特性探测 + 收窄。
 *
 * 实测 2.0.22 的 api.storage.store / memory 是 **(key, value?) => unknown 函数**，
 * 不是暴露 get/set 的对象：读 = 单参调用，写 = 双参调用，宿主已自动加
 * `plugin.<pluginId>.` 前缀。且两条路径在 2.0.22 上**必然抛异常**（读抛
 * `b.initial`，写连 `{a:1}`/`false` 都报 "must be JSON-compatible objects"，
 * setup/+4s/+12s 表现一致，非初始化竞态，宿主 bug）。所以本层所有调用都要
 * try/catch 降级——今天实际走的是内存 Map 兜底，但**宿主哪天修好 storage，
 * 持久化无需改代码即自动生效**，这是保留这个分支的唯一理由。
 *
 * 有了这层适配，src/ui/panel.tsx **零改动**：它继续按 TuiKV 形状拿 kv。
 * ⚠️ 实测结论：2.0.22 上 api.storage 每次调用都抛，持久化实际不可用，
 * 面板的折叠/边框状态在该版本上**仅本次会话内有效**，重启即回到默认。
 * 键名前缀 quota_switch 保持不变——存量数据在用户 DB 里，必须兼容。
 */
import type { TuiKV } from "@opencode-ai/plugin/tui"

/** api.storage.store / memory 的真实形状：(key, value?) 函数，宿主负责加前缀 */
type StorageFn = (key: string, value?: unknown) => unknown

function isTuiKV(v: unknown): v is TuiKV {
  if (v === null || typeof v !== "object") return false
  const r = v as Record<string, unknown>
  return typeof r.get === "function" && typeof r.set === "function"
}

function asStorageFn(v: unknown): StorageFn | undefined {
  return typeof v === "function" ? (v as StorageFn) : undefined
}

/** 兜底：会话内内存 Map，面板当次仍可用（与全文件「静默降级」同一姿态） */
function memoryKV(): TuiKV {
  const m = new Map<string, unknown>()
  return {
    get: <V,>(key: string, fallback?: V): V => (m.has(key) ? (m.get(key) as V) : (fallback as V)),
    set: (key, value): void => {
      m.set(key, value)
    },
    ready: true,
  }
}

/**
 * 优先级：api.kv（老宿主，原样透传）→ api.storage.store（持久那份）→
 * api.storage.memory → 纯内存。2.0.22 上后两者每次调用都抛，等效内存 Map；
 * ready 无从探测，恒 true（panel.tsx 的 1s 轮询最多白跑 1s，无副作用）。
 */
export function resolveKV(api: unknown): TuiKV {
  const r = (api ?? {}) as Record<string, unknown>
  if (isTuiKV(r.kv)) return r.kv

  const storage = (r.storage ?? {}) as Record<string, unknown>
  const backend = asStorageFn(storage.store) ?? asStorageFn(storage.memory)
  if (backend) {
    return {
      get: <V,>(key: string, fallback?: V): V => {
        try {
          const v = backend(key)
          return (v === undefined ? fallback : v) as V
        } catch {
          return fallback as V
        }
      },
      set: (key, value): void => {
        try {
          backend(key, value)
        } catch {
          /* 写失败静默降级 */
        }
      },
      ready: true,
    }
  }
  return memoryKV()
}
