# opencode-quota-switch

OpenCode v2 TUI 插件：**侧边栏自动跟随当前会话正在用的 provider** 显示套餐用量。

切到 MiniMax 就显示 MiniMax，切到 GLM 就显示 GLM——不用手动切开关。

## 支持的 provider

| Provider | 展示内容 | 数据源 |
|---|---|---|
| **GLM / 智谱** | 5h / 周 / MCP 三窗口 + 套餐等级 | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| **MiniMax** | 5h + 周（按套餐档位决定是否显示） | `api.minimaxi.com/v1/token_plan/remains` |
| **Kimi for Coding** | 5h + 周 + 月消 | `api.kimi.com/coding/v1/usages` |
| **DeepSeek** | 仅账户余额 | `api.deepseek.com/user/balance` |

> DeepSeek **没有 Coding Plan**，只按量计费，没有任何配额窗口接口（`/user/coding_plan`、`/coding/v1/usages`、`/user/usage` 均 404）。所以它只显示余额，这是完整而非残缺的实现。

## 工作原理

```
槽位 props.session_id
      ↓
src/active-provider.ts   会话内最近一条消息的 providerID → 回落配置默认模型
      ↓
src/providers/index.ts   providerID → adapter（含多 provider 时的优选规则）
      ↓
src/parsers/*.ts         纯函数解析，无网络、无依赖
      ↓
src/ui/panel.tsx         Solid 面板渲染
```

判定优先级：**会话内最近一条消息 > 配置默认模型**。切会话时由宿主重新调用插槽，顺带刷新 provider。

## 扩展新 provider

三步，provider 之间零耦合：

1. `src/parsers/<name>.ts` — 写一个 `(json: unknown) => ProviderQuota` 纯函数
2. `src/providers/<name>.ts` — 导出 adapter：`{ id, label, match, prefer?, fetch }`
3. `src/providers/index.ts` — 把 adapter 加进 `PROVIDERS` 数组

`match` 决定认领哪些宿主 provider 条目；同一 provider 有多条目时用 `prefer` 优选（GLM 就靠它区分 coding 端点与 paas 端点）。

## 几个必须知道的坑

**`dependencies` 必须保持为空。** `@opentui/solid` / `@opentui/core` / `solid-js` 全部走宿主提供（只放 devDependencies）。插件自带一份渲染库会出现**两个渲染库实例**，Solid 信号订阅桥接不到宿主渲染循环，面板**冻结在首帧**。上游 `opencode-quota-usage` 正是因为把 `@opentui/core` 钉在 `dependencies` 里，才被迫从 Solid 降级成命令式渲染。

**MiniMax 的 `*_usage_count` 是「剩余」不是「已用」。** 这个端点上字段语义与老版 `coding_plan/remains` 相反，直接读会得到反向数字。所以只用 `current_*_remaining_percent`，`usedPct = 100 - remaining_percent`，永不输出 `used/limit`。

**MiniMax 的 `*_status === 3` 表示「该窗口对你的档位不适用」**，必须整个窗口丢掉，不是显示 0%。

**GLM 监控接口用裸 key**（`Authorization: <key>`，不带 `Bearer`），Kimi / MiniMax / DeepSeek 则是 `Bearer`。混用会静默认证失败。

**GLM 业务失败返回 HTTP 200**（`{success:false, code, msg}`），必须校验信封，否则空 `data.limits` 会伪装成「没有窗口」。

## 命令

| 命令 | 作用 |
|---|---|
| `/quota-refresh` | 立即重新拉取当前 provider 的用量 |

## 配置

`cli.json` 的 `plugins` 数组项可带 `options`：

```jsonc
{
  "plugins": [
    { "package": "./plugins/opencode-quota-switch",
      "options": { "intervalMs": 60000, "providers": ["GLM", "MiniMax"] } }
  ]
}
```

| option | 默认 | 说明 |
|---|---|---|
| `intervalMs` | `60000` | 轮询间隔，下限 15000 |
| `providers` | 全部 | 白名单，值为 adapter id 或展示名 |
| `title` | 按 provider 自动 | 面板标题前缀 |

## 开发

```bash
npm install
npx tsc --noEmit
```

`reference/` 存放上游 `opencode-quota-usage@0.3.7` 的原始文件，仅供对照，不参与编译也不发布。

## 参考项目

本项目在以下开源工作的基础上构建，感谢原作者：

- **[opencode-quota-usage](https://www.npmjs.com/package/opencode-quota-usage)**（MIT）— **本项目的代码基座**。GLM / Kimi / DeepSeek 的解析器与 provider 匹配逻辑派生自它的 `parsers.ts` 与 `main.ts`，其字段语义踩坑注释被完整保留在对应代码上。
- **[opencode-glm-vistatus](https://github.com/WuJunkai2004/opencode-glm-vistatus)**（MIT）— 侧边栏面板的**视觉与交互参考**。折叠行为、Morandi 低饱和调色、半格进度条字形（`█▓░░`）、CJK 宽度对齐工具、重置倒计时格式均参照其实现。
- **[steipete/CodexBar](https://github.com/steipete/CodexBar)** — 各 provider 额度端点、鉴权头与字段语义的主要考证来源，其 `docs/<provider>.md` 是端点事实的可靠出处。
- **[openchamber/openchamber](https://github.com/openchamber/openchamber/blob/main/packages/web/server/lib/quota/DOCUMENTATION.md)** — 额度接口**字段语义陷阱**的权威整理（MiniMax 端点上 `*_usage_count` 返回「剩余」而非「已用」这一点即出自此处）。
- **[farion1231/cc-switch](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/coding_plan.rs)** — 多 provider 套餐额度实现的参照（Kimi / GLM / MiniMax / 火山方舟 / OpenCode Go）。
- **[MiniMax 官方文档](https://platform.minimaxi.com/docs/token-plan/faq)** — `/v1/token_plan/remains` 端点的官方出处。

## License

MIT

`src/parsers/{glm,kimi,deepseek}.ts` 与 `src/http.ts` 派生自 `opencode-quota-usage`（MIT，Copyright its contributors）。`src/ui/` 的渲染手法参照 `opencode-glm-vistatus`（MIT，Copyright WuJunkai2004）。
