# OpenCode 过程展示缺失（思考/工具/流式）分析与修复计划

> 分支：`feature/v0.5.9-optimize-opencode-process-display`
> 依据：2026-09-29 本机实测（opencode CLI **1.18.32**，Windows，`run --format json` 原始事件采样；
> 样本存于 `docs/opencode/samples/opencode-1.18.32/`，并经 opencode 上游 `run.ts` 源码交叉确认）
> 性质：**新会话执行文档**。本文件自包含：现象、根因（含 file:line）、修复步骤、验收标准。

---

## 0. 结论速览

| 编号 | 现象 | 根因层 | 新引入 or 先存在 |
|---|---|---|---|
| RC1 | **工具调用过程完全不显示**（无工具卡片，只有最终文本） | daemon 解析层：OpenCode 只在工具**完成时**发**单个** `type:"tool_use"` 事件（`state.status:"completed"` 自带 input+output），`parseOpenCodeEvent` 对该形态只发 `tool_result` marker、**从不发 `tool_use` 块** → webview 收到无主 `tool_result`，配对失败，工具卡片无法渲染 | 先存在（解析器按"started→completed 两段式"假设编写，与 1.18 实际格式不符） |
| RC2 | **思考过程完全不显示** | CLI 参数层：非交互 `run` 模式下 `--thinking` 默认 **false**，OpenCode 根本不输出 reasoning part（实测对照：同 prompt 加 flag 有 reasoning 事件、不加为 0 条）；`buildOpenCodeArgs` 从不加该 flag | 先存在 |
| RC3 | **文本也只是最后一次性出现**（无流式打字机效果，整体观感"只显示最终结果"） | CLI 能力边界：`run --format json` 源码确认只在 part **完成时**输出（text/reasoning 看 `part.time?.end`，tool 看 `state.status`），**不存在 delta 流**。属 CLI 能力上限，非本仓库 bug | 先存在（MVP 选型即如此） |

三者叠加 = 用户观察到的"OpenCode 只显示最终结果"：RC3 决定即使一切正常，过程也是"一步一坨"非流式；RC1/RC2 则让工具卡片与思考块**彻底消失**。

---

## 1. 证据（实测，opencode 1.18.32）

### 1.1 事件形态（样本：`docs/opencode/samples/opencode-1.18.32/*.jsonl`）

工具回合（`tool-call-turn.jsonl` / `slow-tool-turn.jsonl`）：

```json
{"type":"step_start", "part":{"type":"step-start", ...}}
{"type":"tool_use",  "part":{"type":"tool","tool":"bash","callID":"call_2b401be8a6be4077ba939fae",
  "state":{"status":"completed","input":{"command":"echo hello-from-opencode"},
           "output":"hello-from-opencode\n","metadata":{...},"title":"echo hello-from-opencode"}}}
{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{...}}}
{"type":"step_start", ...}
{"type":"text",      "part":{"type":"text","text":"`hello-from-opencode`","time":{"start":...,"end":...}}}
{"type":"step_finish","part":{"type":"step-finish","reason":"stop", ...}}
```

- 工具 part **只有一条**、状态即最终态（`sleep 6` 的慢工具同样只有一条 completed，无 pending/running 中间事件）。
- 文本 200 词 → **单条** `text` 事件 1171 字符一次性输出（`long-text-turn.jsonl`）。

思考回合对照：

- 带 `--thinking`：`{"type":"reasoning","part":{"type":"reasoning","text":"…391…"}}` 出现（`thinking-turn-with-flag.jsonl`）。
- 不带：`grep '"type":"reasoning"'` = **0 条**（`thinking-turn-without-flag.jsonl`），但 `step_finish.tokens.reasoning` 仍有计数——模型思考了，CLI 把它吞了。

### 1.2 上游源码确认（`packages/opencode/src/cli/cmd/run.ts`，dev 分支）

- text：`part.type === "text" && part.time?.end` 才 emit；
- reasoning：`part.time?.end && thinking` 才 emit，且 `thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)` —— **非交互 run 默认 false**；
- tool：仅 `state.status === "completed" | "error"` 时 emit（事件 type 恰好也叫 `tool_use`）；
- `emit()` 只在 `--format json` 下写 stdout，事件间无 delta。

---

## 2. 代码链路与根因（file:line）

```
opencode run --format json（ai-bridge/services/opencode/message-service.js:262-280 buildOpenCodeArgs）
  → runCliStreaming 按行回调（ai-bridge/utils/cli-spawn.js:133-151）
  → parseOpenCodeEvent(message-service.js:132-229) 分类
  → marker 协议输出（ai-bridge/utils/marker-protocol.js）
Java: MarkerCliBridge.processOutputLine（MarkerCliBridge.java:50-123）
  → [MESSAGE] type=assistant(user) → ClaudeMessageHandler.handleAssistantMessage/handleToolResult(:603-636)
  → notifyMessageUpdate → webview 按 tool_use_id 配对渲染工具卡片
```

### 2.1 RC1 断点：单事件 completed 工具被解析成"孤儿 tool_result"

`parseOpenCodeEvent` 的 tool 分支（message-service.js:172-223）：

- 判定进入：`lower === 'tool_use'` ✓（OpenCode 的事件 type 恰好就是 `tool_use`，能进分支）；
- 关键 if（:210）：`status === 'completed' || … || rawOutput != null || error` → 走 `tool_result` 返回。**1.18 的事件永远满足此条件**（单事件即 completed），于是：
  - `emitToolUseMessage` **永远不会执行**（onLine 的 `case 'tool_use'` 分支 :355-360 拿不到事件）；
  - `emitToolResultMessage` 发出的 `tool_result` 在 webview 侧找不到前置 `tool_use` 块 → 无从渲染。
- 次级缺陷（:181-190）：toolId 候选顺序 `event.id → part.id → part.callID …`，`part.id`（`prt_…`）排在 `callID`（`call_…`）之前，即使配对成功 id 也与模型侧 callID 不一致。

### 2.2 RC2 断点：`--thinking` 缺失

`buildOpenCodeArgs`（message-service.js:262-280）只拼 `run --format json [--model] [--session] <prompt> [-f …]`。
reasoning 事件被 CLI 上游吞掉，daemon 无从解析（解析逻辑本身 :167-170 对 `reasoning` 类型是正确的）。

### 2.3 RC3 说明：非 bug，是 `run` 的能力上限

`run --format json` 无任何 delta 模式（见 1.2）。真流式唯一路径是 `opencode serve` +
SDK 事件订阅（`message.part.updated` 增量、工具 running 状态）——`opencode-channel.js:2-3`
注释明确"serve in MVP 之后再说"。本次不做，单列二期。

### 2.4 下游（Java/webview）无需改动

- `[THINKING_DELTA]`、`[MESSAGE]` 工具块、`tool_result` 配对渲染在 Claude 主链路已验证可用
  （MarkerCliBridge.java:76-95；ClaudeMessageHandler.java:603-636 追加 USER `[tool_result]` 消息，
  webview `toolBlocks/*` 按 `tool_use_id` 配对）。Grok/Kimi 走同一 marker 协议，工具卡片正常。
- 结论：解析/展示修复收敛在 daemon 的 message-service.js；唯二的 Java 改动是 F3/F5 的
  开关透传（`sendToCliProvider` 读思考设置、MarkerCliBridge 的 stdinInput 补 `thinking` 字段；
  `permissionMode` 已在 stdinInput 中，OpenCode 通道解构即可）。

---

## 3. 修复方案

文件：`ai-bridge/services/opencode/message-service.js`（+ 测试 `message-service.test.js`）

### F1（必做）—— 按 `part.type` 分类事件

`parseOpenCodeEvent` 目前只看 `event.type` 字符串猜测。改为优先读 OpenCode 1.x 的
`event.part.type`：`text`→text、`reasoning`→thought、`tool`→tool、`step-start/-finish`→忽略；
旧的 type 名匹配保留为 fallback（兼容旧版本/其它 CLI 变体）。这是 F2 的前提。

### F2（必做）—— completed 单事件合成"tool_use + tool_result"对

tool 分支重写：

- `status` 为 `pending/running`（未来版本可能出现）：只 emit `tool_use`（去重）；
- `status` 为 `completed/error`（1.18 唯一形态）：**先 emit `tool_use` 再 emit `tool_result`**：
  - id 一律取 `part.callID` 优先（fallback `part.id`），两 marker 用同一 id 保证配对；
  - `tool_use`: name = `part.tool`（fallback 现有候选链），input = `state.input`；
  - `tool_result`: content = `state.output`（或 error 文本），isError 按 status；
- `seenToolStarts` 去重键同步改为该 callID（若未来先来 started 再来 completed，
  completed 时跳过重复 tool_use、只补 tool_result —— 两段式与单事件式统一处理）。

### F3（必做）—— "是否开启思考"开关透传 → `--thinking`

OpenCode 的 reasoning part 由 CLI 的 `--thinking`（布尔）控制，非交互 run 模式默认 false。
**跟随插件的"是否开启思考"开关，不固定开启**（若固定开启，该开关对 OpenCode 就是第二个摆设）：

- Java：`sendToCliProvider`（SessionSendService.java:503-563）读取思考开关并加入 stdin。
  开关状态与 webview 同源：provider `settingsConfig.alwaysThinkingEnabled`，fallback Claude
  settings.json 的 `alwaysThinkingEnabled`（webview 显示逻辑见 ChatScreen.tsx:350；
  Java 侧 `CodemossSettingsService.getAlwaysThinkingEnabledFromClaudeSettings()` 已有，
  provider 级 getter 如缺则补）。stdinInput 缺省 `thinking=true`（与 Claude daemon
  `resolveThinkingTokens` 的 `?? true` 对齐，persistent-query-service.js:81）。
- daemon：opencode-channel.js 解构 `thinking`，`buildOpenCodeArgs` 仅在 `thinking === true`
  时追加 `--thinking`；关=不追加，reasoning 不输出、UI 无思考块，与 Claude 关思考语义一致。
- 注意 webview 的 ConfigSelect 里两个开关对所有 provider 无条件显示（ConfigSelect.tsx:291-311），
  OpenCode 用户看得见、当前点不动任何东西——这正是 F3 必须做成"跟随开关"而非"固定开"的原因。

### F4（必做，健壮性）—— text/reasoning 增量去重

按 `part.id` 记录上次已发文本、只发**新增后缀**（`novel = full.slice(lastLen)`，仅当
`full.startsWith(last)` 才增量，否则全量重发）。当前 1.18 每 part 只发一次、无实际影响，
但防未来版本对同一 part 重复推送时文本在 UI 里翻倍（与 Claude 流的 novel-delta 语义对齐）。

### F5（可选）—— permissionMode → `--auto`

stdin 已带 `permissionMode` 但 opencode 通道完全忽略。映射：`bypassPermissions` → 追加
`--auto`（OpenCode 的"自动批准未被显式拒绝的权限"）。default/acceptEdits 维持现状。
避免 headless 下权限询问造成回合卡死（本次实测 bash 默认放行，未复现卡死，故列可选）。

### F6（可选）—— reasoningEffort → `--variant`

`sendMessage` 的 `_reasoningEffort` 现为占位。OpenCode 有 `--variant`（provider 专属推理力度，
如 high/max/minimal），非空且非默认值时追加。可与 F3 联调，不改也不影响本次主目标。

### 开关效果矩阵（一期完成后，F1-F5 落地）

两个开关的现状语义（以 Claude 提供商为基准）：**思考开关**= `alwaysThinkingEnabled`
（写入 Claude settings.json + provider settingsConfig，daemon `resolveThinkingTokens`
控制 maxThinkingTokens）；**流式开关**= `streamingEnabled`（按项目存储、默认开，daemon
`includePartialMessages` 控制是否订阅增量事件）。两者在 UI 的配置菜单中对所有 provider
无条件显示。

OpenCode 现状：`sendToCliProvider` 两个开关都不读不传，daemon 侧也无对应能力——
**双双无效**。一期完成后的四种组合：

| 思考开关 | 流式开关 | OpenCode 一期实际效果 |
|---|---|---|
| 开（默认） | 开（默认） | 工具卡片、思考块、文本**按 step 完成顺序分块出现**（每步完成时整块到达，无打字机） |
| 开 | 关 | **与上一行完全相同**。CLI 无 delta 可关：OpenCode 本来就是 part 完成才输出，"关流式"无差可打 |
| 关 | 开 | 思考块消失（不加 `--thinking`），工具卡片、文本照常分块出现 |
| 关 | 关 | 同上一行 |

要点：

- **思考开关经 F3 后真实生效**（开=有思考块、关=无），四种组合里唯一产生可见差异的开关。
- **流式开关一期对 OpenCode 保持 no-op**：不是漏实现，而是 `run --format json` 没有 delta
  数据源，开与关只能长成一模一样。UI 不隐藏该开关（与现状一致，避免按 provider 差异化
  UI），二期 serve 方案落地后自然生效（`message.part.updated` 增量 → 打字机 + 工具
  running 实时状态）。
- 与 Claude 提供商的体验差距（一期结束时）：Claude 流式有打字机、工具卡片"执行中"即显示
  红点/转圈；OpenCode 一期是"每步完成时一次性亮出结果"。这是数据源差异，不是渲染缺陷。

### 优化前后对比（典型"搜索→读取→修改→总结"任务）

- **优化前**：用户消息后长时间只有"生成中"→ 最后文本一次性出现。工具在后台执行了
  但无任何卡片，模型思考了但无任何痕迹——即"只显示最终结果"。
- **优化后（思考开）**：step1 完成时工具卡片亮出（含命令与输出，可展开）→ step2 完成时
  思考块+文本段出现 → 多工具任务逐块按序推进。**分块推进、非打字机**（RC3 上限）。
- **优化后（思考关）**：同上，但无思考块。

### 二期（单列，本次不做）—— `opencode serve` + SDK 事件订阅

真流式（打字机 delta、工具 running 实时状态）需托管 `opencode serve` 子进程 + 订阅
`message.part.updated` / `session.status` / `permission.asked` 事件，涉及服务生命周期、
端口/鉴权、事件路由与会话恢复，规模另估。RC3 的"一步一坨"观感在二期前无法消除。

### 明确不做

- 不改 webview（开关按钮本就对所有 provider 显示，无需动）；
- 不做 run 模式下的假流式（模拟打字机）——数据源无 delta，造假徒增复杂度；
- 流式开关一期对 OpenCode 不产生任何行为差异（矩阵见 3.x），不做"关流式时换用
  `[CONTENT]` marker"之类的表面兼容——一次性全文场景下两者渲染等价，不值得动；
- 不动 Grok/Kimi 共用的 marker 协议与 `runCliStreaming`。

---

## 4. 验证计划

1. **单元测试**（`message-service.test.js`，直接用 `docs/opencode/samples/opencode-1.18.32/*.jsonl` 做 fixtures）：
   - tool-call-turn：断言先收到 `type:assistant` 的 tool_use（name=bash、input.command=echo、id=call_…），
     再收到 `type:user` 的 tool_result，二者 id 相同；不再出现无主 tool_result；
   - slow-tool-turn：同上（确认无中间事件时也只产出干净的一对）；
   - thinking-turn-with-flag：思考开时断言收到 `[THINKING_DELTA]`（marker 层可用 spy/捕获 stdout 断言）；
   - long-text-turn：断言文本只出现一次、内容完整（F4 回归）；
   - buildOpenCodeArgs：`thinking=true` 含 `--thinking`；`thinking=false`/缺省不含（缺省按
     Java 侧补的默认值约定断言）；permissionMode=bypassPermissions 时含 `--auto`（F5）。
2. **GUI 验收**（OpenCode 免费模型 + 触发工具的任务，按 3.x 矩阵过四种开关组合）：
   - 思考开关：开→思考块出现（可折叠）、关→无思考块，即时生效（无需重启会话）；
   - 流式开关：开/关均无差异（记录在案，验收时不作为缺陷）；
   - 工具卡片出现（bash 命令、输入、输出可折叠展开），与最终文本顺序正确；
   - 无重复文本；无"孤儿结果"碎片；
   - 多步任务（工具→文本→工具→文本）各步按完成顺序逐步出现（**预期为分块出现、非打字机流式**，
     RC3 上限，验收标准按此校准）；会话续聊（--session）不受影响。
3. **不回归**：Claude 通道思考/流式开关语义不变；Grok/Kimi 通道（共用 marker-protocol/
   cli-spawn 未动）、OpenCode 图像附件（-f 路径）、session 续接、错误事件展示。

## 5. 风险与备注

- OpenCode 版本耦合：事件形态按 1.18.32 固化（上游还在活跃演进）。F1 的 fallback 链与
  fixtures 回放可低成本跟进版本变化；样本 README 记录了完整采集命令，可随时重采。
- `--thinking` 对不支持 reasoning 的模型无副作用（无 reasoning part 即无输出）。
- F2 合成的 tool_use/tool_result 与历史回放（`OpenCodeHistoryReader`）是两条独立链路；
  本次不动历史回放，若回放侧同样缺工具/思考展示，另立计划。
- 采样会话含本机 sessionID（ses_…），非敏感信息，已按 `docs/opencode/STREAMING-EVENT-LOGS.md`
  的 fixtures 化思路留档。
