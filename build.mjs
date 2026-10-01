/**
 * 预打包成 dist/tui.js —— 形态照抄 opencode-glm-vistatus，原因是实测出来的：
 *
 * 宿主加载 npm 缓存里的 TUI 插件时，走的是「已打包产物」那条解析路径。
 * 如果直接把 main.ts（裸 TS 源码）发出去，宿主的转译器不注入宿主侧的
 * solid-js / @opentui/solid 解析，实测报：
 *   Cannot find package 'solid-js' imported from .../src/ui/panel.tsx
 * （插件缓存目录向上找不到 ~/.config/opencode/node_modules，两棵不同的树；
 *   而 devDependencies 消费者不会安装，peerDependencies 才会。）
 *
 * 所以必须打成单文件 dist/tui.js，并且把运行时依赖标记为 external——
 * 由宿主提供那一份实例。这也是避免「双渲染库实例 → UI 冻结在首帧」的前提：
 * 绝不能把 solid-js / @opentui/solid 打进 bundle。
 */
import { build } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

/** 宿主提供的运行时依赖：保持 external，绝不内联 */
const EXTERNAL = [
  "solid-js",
  "solid-js/*",
  "@opentui/solid",
  "@opentui/solid/*",
  "@opentui/core",
  "@opentui/core/*",
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/*",
  "node:*",
]

await build({
  entryPoints: ["main.ts"],
  outfile: "dist/tui.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: EXTERNAL,
  // 自定义渲染器（opentui）不是 DOM：
  // - generate:"universal"  → 用自定义渲染器模式，而不是 DOM/ssr
  // - moduleName:"@opentui/solid" → helper 从 @opentui/solid 取。
  //   不写会默认成 solid-js/web，那是 DOM 那套，渲染到 opentui 上不会显示。
  //   默认值对齐 @opentui/solid/scripts/solid-plugin.ts 里的 moduleName ?? "@opentui/solid"
  plugins: [solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } })],
  logLevel: "info",
})

console.log("✓ dist/tui.js 构建完成")
