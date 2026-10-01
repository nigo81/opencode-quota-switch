/**
 * UI 层公开面。main.ts 只跟这个文件打交道。
 *
 * 面板本体（./panel.tsx）只消费 src/types.ts 里冻结的 QuotaSnapshot，
 * 不认识任何 provider —— 数据怎么来、槽位怎么注册，全在 main.ts 那边。
 *
 * 运行时依赖只有 solid-js / @opentui/solid / @opencode-ai/plugin，
 * 三者全部由宿主提供。绝不能写进 package.json 的 dependencies：
 * 多带一份渲染库实例，Solid 信号订阅桥不到宿主渲染循环，首帧就冻住
 * （upstream opencode-quota-usage 的实证事故）。
 *
 * 出口只留组件与其 props 类型：theme/format/widgets 里的 helper 是给 panel.tsx 内部用的，
 * 面板自己直接从 ./theme.js、./format.js、./widgets.js 取，不走本文件。
 * 在这里再转发一遍没有任何消费者（tsc 的 noUnusedLocals 也不管 export，拦不住这类死出口），
 * 徒增「改了这行到底影响谁」的排查成本——所以只转发真正跨层的那一个。
 */

export { QuotaPanel } from "./panel.js"
export type { QuotaPanelProps } from "./panel.js"
