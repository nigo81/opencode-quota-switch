/**
 * `npm test` 的 ESM 解析钩子：把 TS 源码里的 `./x.js` 说明符解析到 `./x.ts`。
 *
 * 为什么需要：本仓源码按 TypeScript 的 NodeNext 约定写相对 import 时一律带 `.js` 后缀
 * （`import ... from "./types.js"`，编译后才是对的）。Node 原生的类型擦除（type stripping）
 * 只擦类型，**不重写说明符**，直接 `node --test` 会报
 * `ERR_MODULE_NOT_FOUND .../src/authfile.js`。tsc/tsx 会处理这个映射，Node 不会。
 *
 * 为什么用 data: URL 内联：钩子必须在独立线程里 evaluate，一个文件就够，
 * 不必为了 8 行代码多出一个 .mjs。钩子源码内联在这里反而更容易读全。
 *
 * 只对「相对路径 + .js 后缀 + 同名 .ts 确实存在」改写，其余一律交回默认解析，
 * 所以 `node:fs` / `solid-js` 之类不受影响。
 */
import { register } from "node:module"

const HOOK_SOURCE = `
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)
