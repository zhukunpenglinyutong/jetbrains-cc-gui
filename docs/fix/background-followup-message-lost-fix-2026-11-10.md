# BUG 报告：后台任务续回合（follow-up turn）的 AI 响应内容不上屏

- 日期：2026-11-10
- 严重级别：高（功能缺陷，非崩溃；影响所有后台任务场景的交互完整性）
- 影响范围：ai-bridge（Node daemon）→ Java 插件 → webview 全链路
- 关联历史：#1305（inter-turn result 路由，已修复）、#1410（one-behind shift）
- 状态：已定位根因，待修复（2026-11-10 修订：根因 2 已按事故日志更正，见第 4 节修订说明）

## 1. 问题概述

当 AI 在回合内启动后台任务（Agent 子代理、`run_in_background` 的 Bash 等）后回合正常结束，后台任务完成通知会在**回合外**（inter-turn）到达 CLI 并触发一次 AI 的 follow-up 回合。该 follow-up 回合的 assistant 正文消息（即 AI 对任务结果的分析、报告、结论）**在界面上永远不显示**：

- 消息已被 CLI 持久化到会话 JSONL
- 消息存在于 daemon 进程内的模型上下文中（AI "知道"自己生成过）
- 但既不实时上屏，也不保证通过 reload 路径恢复

### 用户视角的现象

1. AI 回复"任务已在后台运行，结果出来后我会继续"，回合结束，界面停在等待状态
2. 后台任务完成，AI 实际生成了完整的结果报告（JSONL 可查）
3. 界面无任何变化
4. 用户发送新消息后，AI 的行为像是"已经汇报过结果"，但用户从未看到——造成"AI 跳过了汇报直接做下一步"的错觉，且在授权敏感场景（如实施代码变更）会引发严重的沟通错位

### 实际事故案例（2026-11-09）

用户会话中 AI 启动双后台分析任务后回合结束（界面显示"运行中"）。AI 在 follow-up 回合生成了完整研究报告与 4 个待选方案（存在于上下文），用户界面从未渲染。用户点"继续"（意图：催促出报告），AI 却按自己上下文将"继续"理解为"已看过方案、批准实施"，直接修改了用户项目源码，引发严重误会。

## 2. 复现步骤

1. 在插件会话中让 Claude 启动一个后台任务（Agent 工具后台运行，或 `run_in_background` 的长命令）
2. 等待当前回合正常结束（收到 result，界面回合完成）
3. 等待后台任务完成（观察 daemon 日志出现 follow-up 活动）
4. 预期：界面出现 AI 对任务结果的响应；实际：界面无任何新消息
5. 检查会话 JSONL（`~/.claude/projects/<project>/<session>.jsonl`）：follow-up 的 assistant 消息**已持久化**，证明消息产生但渲染链路丢失
6. 变体复现（时序竞态，问题 3）：在第 4 步进行中立刻发送新用户消息，follow-up 的 result 会被 in-turn 分支 skip，reload 路径同样不触发

## 3. 排查过程

排查自用户现象出发，自上而下穿过三层：

### 3.1 排除"消息未产生"

检查会话 JSONL：follow-up 的 assistant 消息存在。证明 CLI 正常处理了任务通知并触发 follow-up 回合，消息在 SDK 管道上流过。问题定位在**消费与转发**侧。

### 3.2 bridge 层（Node daemon）：发现静默消费点

`ai-bridge/services/claude/persistent-query-service.js`：

- L311：`runtime.turnSink = createTurnSink()` — 每回合创建 sink
- L316-424：`executeTurn` 主循环从 sink 取消息，L413-423 收到 `result` 即 `break`
- L469：finally 中 `runtime.turnSink = null` — 回合结束，进入 inter-turn 模式

消息的唯一消费者是 `ai-bridge/services/claude/runtime-lifecycle.js` 中的 perpetual reader（L484 起，唯一持有 `runtime.query.next()` 的循环），其路由逻辑（L568-647）：

```js
if (runtime.turnSink) {
  // IN-TURN MODE: 转发给 executeTurn
  runtime.turnSink.push(msg);
} else {
  // INTER-TURN MODE
  if (msg?.type === 'result') {
    // 仅触发 session_updated 事件（L576-590）
    emitInterTurnEvent(runtime.sessionId);
  }
  if (msg?.type === 'system' && msg.subtype.startsWith('task_')) {
    // 仅转发子代理生命周期事件（L602-613）
    emitTaskEvent(runtime.sessionId, msg);
  }
  // task-notification XML → emitTaskEvent（L625-644）
  // L645-646 注释原文：
  // "For other message types during inter-turn, we silently consume
  //  (they've already been persisted to JSONL by the CLI)"
}
```

**结论：INTER-TURN 模式下 follow-up 回合的 assistant 正文没有转发路径，被静默消费。** L619-620 注释亦承认："the frontend only sees it after a reload"。

### 3.3 Java 层：reload 恢复路径失效

`src/main/java/com/github/claudecodegui/provider/common/DaemonBridge.java` L917-933：`session_updated` 事件仅分发给 listeners。

`src/main/java/com/github/claudecodegui/ui/toolwindow/ClaudeChatWindow.java` L176-194：listener 侧设计了 DeferredReload——流活跃期间到达的 session_updated 先 park，流结束后 drain。该机制本身工作正常，2026-11-10 的真机日志可以看到完整的 `deferring reload to stream end` → `draining deferred session_updated reload after stream end` 配对。

初版报告曾把事故归因于 DeferredReload 的 stream-end 边沿竞态。事后回查 2026-11-09 事故时段（会话 `c632b3fe-fbba-4037-a890-c8df6a469fba`，日志 `C:\Users\28685\AppData\Local\JetBrains\IntelliJIdea2026.1\log\idea.1.log`），实际链路并非如此：

| 北京时间 | 日志 |
|---|---|
| 22:47:04、22:50:53、22:55:43、22:55:55 | `session_updated ... reloading from server`（4 次均为即时 reload） |
| 紧随其后约 0.3s | `Ignoring history result that has not persisted the live narrative`（4 次全部被拒绝） |

全程没有出现 `deferring reload to stream end`，说明事件到达时流并不活跃，DeferredReload 的竞态窗口在这起事故中没有出现。

真正的拦截点是 `src/main/java/com/github/claudecodegui/session/SessionMessageOrchestrator.java:331-336` 的 live-narrative 守卫：

```java
if ("claude".equals(requestedProvider)
        && !historyKeepsLiveNarrative(loadedMessages, currentMessages, alignedAnchorIndex)) {
    LOG.warn("Ignoring history result that has not persisted the live narrative");
    requireRestoreCommit(updateSharedLoadingState);
    return;
}
```

该守卫的本意是防止滞后的分页读取覆盖实时流内容；但当 follow-up 正文只存在于 JSONL、live 列表由流式消息构成时，两者的文本、thinking 与结构无法逐条对齐，守卫会把这份本应补上内容的 reload 整体丢弃。同文件 L735-742 的注释已描述这一后果：

> "The newest turns would then never appear ... Only navigating away and back (which rebuilds the session with an empty live list) shows the content."

会话 JSONL 侧可交叉验证：`c632b3fe-fbba-4037-a890-c8df6a469fba.jsonl` 中 14:55:43.091Z 与 14:55:55.332Z 各有一条 assistant 正文（对应北京时间 22:55:43 / 22:55:55），与两次 session_updated 相隔约 0.6 秒，证明消息已落盘、只是未被应用。

### 3.4 webview 层

`webview/src/version/changelog.ts` L829/L870 证实：#1305 的修复仅为 inter-turn 的 **result** 消息增加了路由（"将轮次间结果作为 session_updated 事件路由"），follow-up 的 assistant 正文从未纳入。

### 3.5 时序竞态确认

`ai-bridge/services/claude/persistent-query-service.js` L353-359：

```js
if (msg?.type === 'result' && msg.origin?.kind === 'task-notification') {
  console.log('[LIFECYCLE] Skipping task-notification result for active user turn');
  continue;
}
```

若 follow-up 的 result 恰好落在下一个用户回合活跃期间，它被直接 skip——既不结束当前回合（合理），也**不触发 session_updated**（缺失），reload 恢复路径同时失效。

## 4. 根因结论

> **修订说明（2026-11-10）**
>
> 初版报告的第 2 条根因，是依据 `ClaudeChatWindow` 中的代码注释做静态推断得出的，未与事故当天的运行日志交叉核对，这是我们的误判。回查 2026-11-09 事故日志与会话 JSONL 后确认：4 次 `session_updated` 全部走了即时 reload，没有任何一次进入 defer 分支，DeferredReload 的 500ms 兜底逻辑并未参与这次事故；真正拦截消息的是 `SessionMessageOrchestrator` 的 live-narrative 守卫。
>
> 由此给此前基于初版结论投入排查的同学们增加了额外的工作量，我们深表歉意。第 3.3 节与本节表格已按实际日志更正；根因 1、根因 3 以及第 5 节的修复方向不受影响。

| # | 层 | 位置 | 问题 |
|---|---|------|------|
| 1 | bridge（主因） | `runtime-lifecycle.js:572-647` | INTER-TURN 模式对 assistant/user 正文消息无转发路径，静默消费；设计依赖"JSONL 落盘 + reload"延迟恢复，而该恢复路径不可靠 |
| 2 | Java | `SessionMessageOrchestrator.java:331-336`（`historyKeepsLiveNarrative`） | session_updated 触发的分页 reload 与 live 列表对不上时被整体拒绝，follow-up 正文虽已落盘却未应用到界面；日志特征为 `Ignoring history result that has not persisted the live narrative` |
| 3 | bridge（时序） | `persistent-query-service.js:353-359` | in-turn 期间到达的 task-notification origin result 被 skip 且不触发 reload，恢复路径在竞态下同时失效 |

消息丢失 = 问题 1 的设计缺口 + 问题 2/3 使 reload 恢复路径不可靠，三者叠加。

## 5. 修复建议

### P0：bridge 层为 inter-turn 正文消息增加实时转发（根治）

- `runtime-lifecycle.js` INTER-TURN 分支：对 `assistant`（及携带正文内容的 `user`）消息新增转发，通过既有 `emitDaemonEvent` 管道发出新事件（如 `inter_turn_message`），携带 sessionId 与完整消息体。参考 `task_event`（L94-96）的既有实现模式
- `DaemonBridge.java`：新增 `inter_turn_message` case，仿照 `task_event` 的双路径投递（L960-973 注释描述的 defense-in-depth 模式）分发给 listeners
- 前端（webview）：新增对应 window callback，将 follow-up assistant 消息追加渲染到当前会话消息列表，并复用 `messageSync.ts` 的快照合并逻辑防止与后续 reload 重复

注意：转发时需区分 `parent_tool_use_id` 非空的 sidechain 消息（保持现行的排除规则，见 persistent-query-service.js L343-351 注释）。

### P1：堵住 in-turn skip 的竞态窗口

- `persistent-query-service.js` L353-359：`continue` 前追加 `emitInterTurnEvent(runtime.sessionId)`（保留 skip 语义——不让 follow-up result 错误结束当前用户回合，但要触发 reload 使内容可达）
- 该处 skip 时 assistant 正文已由 turnSink 进入当前回合流，归属处理需对照 #1410 的 "one-behind" 教训，避免错误归属到当前用户回合

### P2：修正 live-narrative 守卫，并加固 DeferredReload（可选）

- `SessionMessageOrchestrator.java`（本次事故的直接修复点）：`historyKeepsLiveNarrative` 失败时不再整体丢弃 reload，退化为"保留 live 前缀、只追加尾部缺失消息"的合并；或在守卫失败后安排一次延迟重试，避免包含新内容的 reload 被永久丢弃
- `ClaudeChatWindow.java`（一致性加固）：DeferredReload 可继续收敛为状态查询式 drain——reload 请求落地时若流不活跃则立即执行，活跃则登记并在活性检测点以"当前是否仍活跃"为准 drain。2026-11-09 事故未走到该路径，此项优先级已下降，可在后续版本中处理

### 实施顺序建议

P0 独立可交付，直接消除"永久不可见"；P1/P2 加固恢复路径。P0 落地后 reload 从"唯一恢复手段"降级为"一致性兜底"，但 P2 中的守卫修正仍是本次事故的直接修复点，建议与 P0 一并交付；DeferredReload 的进一步收敛可延后。

## 6. 验证方案

### 日志观察点（修复前后对比）

复现步骤 1-4 期间观察 daemon stdout 与 Java 侧日志（IDEA `Help → Show Log in Files`）：

| 日志 | 含义 |
|------|------|
| `[PERPETUAL_READER] Inter-turn result detected, emitting session_updated` | 走了 reload 路径但前端未显示 → 问题 2 |
| `Ignoring history result that has not persisted the live narrative` | reload 结果被 live-narrative 守卫拒绝 → 问题 2 的直接证据（2026-11-09 事故即命中此条） |
| `[ClaudeChatWindow] session_updated during active turn, deferring reload to stream end` | 流活跃期间到达，进入 DeferredReload 等待；正常情况下应随后出现 `draining deferred session_updated reload after stream end`。只有前者长期无后者，才是边沿竞态 |
| `[LIFECYCLE] Skipping task-notification result for active user turn` | 时序竞态命中 → 问题 3 |
| 以上皆无 | follow-up 消息未产生 → 上游 CLI/SDK 问题（本报告范围外） |

修复后应出现新增的 `inter_turn_message` 事件日志，且界面实时渲染 follow-up 内容。

### 测试建议

- `runtime-lifecycle` 已有测试基建（`runtime-registry.lifecycle.test.js`、`perpetual-reader-integration.test.js`）：新增用例——inter-turn 期间注入 assistant/user 正文消息，断言新事件被发出且携带完整消息体
- `persistent-query-service` 测试（`persistent-query-service.test.js` 等）：新增用例——in-turn 期间到达 task-notification origin result，断言 skip 同时 emitInterTurnEvent 被调用
- Java 侧：新增 `historyKeepsLiveNarrative` 用例——分页 reload 返回的内容包含 follow-up 正文、而 live 列表由流式消息构成时，断言 reload 不被整体丢弃（或退化为尾部合并）；DeferredReload 的并发测试可保留为回归保障
- 手工端到端：复现步骤 1-6 全部通过，界面实时显示 follow-up 内容，发送新消息后无重复渲染（验证 messageSync 去重）

## 7. 附录：事故链路图

```
用户消息 → executeTurn() 创建 turnSink → 主循环消费 → result → break
                                                                    ↓
                                            finally: turnSink = null（persistent-query-service.js:469）
                                                                    ↓
【数分钟后】后台任务完成 → CLI 注入 <task-notification> → SDK follow-up 回合
                                                                    ↓
                        AI 响应正文（assistant 消息，用户应看到的报告）
                                                                    ↓
                  perpetual reader 发现 turnSink 为空 → INTER-TURN 模式（runtime-lifecycle.js:569）
                                                                    ↓
        ┌───────────────────────────┬───────────────────────────────┐
        ↓                           ↓                               ↓
   assistant 正文               follow-up result                task-notification XML
   ★ 静默消费，不上屏            → session_updated               → 实时转发子代理卡片
   （仅 JSONL 落盘）             → Java loadFromServer            （唯一有实时路径的）
                                 （reload 结果被
                                  live-narrative 守卫拒绝，
                                  消息仍未应用）
```
