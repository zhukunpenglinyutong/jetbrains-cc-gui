# 流式输出重复渲染问题分析与修复记录

**初版日期**: 2026-04-28  
**修正日期**: 2026-04-29  
**第三轮修正日期**: 2026-05-05  
**版本**: v0.4.1  
**状态**: 阶段 1 已完成且**对 daemon mode 用户生效**；2026-04-29 追加修复第三方 Claude-compatible 模型（MiniMax / GLM / Mimo 等）更易触发的累计 delta 问题；2026-05-05 修复 normalizer fall-through 路径在快照修正场景下的整段 duplicate 输出；前端 `reconcile race` 仍作为放大因素保留跟踪
**初版 Commit**: ddaa590

---

## ✅ 2026-05-05 第三轮修复：normalizer 快照修正路径（本轮修复）

用户在使用 `mimo-v2.5-pro` 等模型时再次反馈：thinking 内容被完整复制一次显示。截图最关键的特征是分隔位置的字符无缝拼接（如 `"Let me implementNow I can see..."`，没有任何空格），证明这是后端字符串硬拼接，不是前端渲染重复。

### 根因

`ai-bridge/services/claude/stream-delta-normalizer.js` 的 `computeNovelDelta` 在三个分支之外存在第四个 fall-through 分支：

```js
return { novel: incoming, next: previous + incoming };
```

这条分支假设 `incoming` 是纯粹的增量片段。该假设对 Anthropic 标准 SDK 成立，但对 mimo / GLM / MiniMax 这类**已经在累计快照模式下偶尔发出修正快照的 provider**不成立——例如某次 delta 把上一次的 `"actual"` 修正为 `"actuall"`，结果两边既不互为前缀也不互为后缀，于是 normalizer 把整条修正快照当新增量再发一次，前端 segment 直接 `+= 整段`，UI 看到完整的复制。

### 改动

1. 在 turnState 上新增 `blockStreamModeByKey: Map`，按 `(kind, blockIndex)` 跟踪每个 block 是 `incremental` 还是 `snapshot` 模式。
2. 一旦某个 block 命中过 `incoming.startsWith(previous)`（确认累计快照），立即锁定为 `snapshot` 模式。assistant 快照如果同样满足前缀延伸关系，也会触发锁定（防止只发一次大块的场景漏检）。
3. fall-through 分支前先看模式：`snapshot` 模式下 silent absorb 修正快照（不再回灌前端）；`incremental` 模式（默认）保持 Anthropic 标准的增量行为。
4. 顺手补上 `previous.startsWith(incoming)` 检测，覆盖 incoming 是 previous 真前缀的陈旧重放场景。

### 验证

- ✅ 新增回归测试 `processStreamEvent: snapshot-mode block absorbs corrective rewrites without duplication` 在修复前精确复现 bug（断言断在 `Let me implementNow I can see` 拼接边界），修复后通过。
- ✅ 新增回归测试 `processStreamEvent: incremental-mode block keeps appending novel deltas` 验证 Anthropic 标准路径未受影响。
- ✅ `node --test ai-bridge/services/claude/stream-event-processor.test.js`：17/17 通过。
- ✅ `node --test ai-bridge/services/claude/stream-event-processor.test.js services/claude/persistent-query-service.test.mjs services/claude/persistent-query-service.helpers.test.mjs services/claude/session-service.test.mjs`：33/33 通过。
- ✅ `cd webview && npx vitest run`：333/333 通过。

### 核心文件

- `ai-bridge/services/claude/stream-delta-normalizer.js`（重写 `computeNovelDelta` + 新增 mode tracking + 在 `rememberStreamSnapshot` 中也锁定 snapshot 模式）
- `ai-bridge/services/claude/stream-event-processor.test.js`（新增 2 个回归测试）

---

## ✅ 2026-04-29 二次复盘：第三方模型累计 delta

用户补充新规律：Claude Code 官方模型基本不出现，但 MiniMax、GLM、Mimo 等 Claude-compatible 模型特别容易在“正常短 thinking → 超长历史 thinking → 正常短 thinking”之间反复切换。

新的最小复现不在前端，而在 ai-bridge 的 `stream_event` 入口：

```text
text_delta: "Now I need to add"
text_delta: "Now I need to add the handler"
```

标准 Anthropic SDK 语义下第二条应是纯增量 `" the handler"`；部分兼容模型实际发送的是“当前 block 累计快照”。旧实现把第二条整段当增量转发，导致 Java / 前端都看到已生成文本被重新追加，随后又被较新的 snapshot / segment 修正，于是视觉上出现图二、图三那种来回跳。

本轮改动：

1. 新增 `ai-bridge/services/claude/stream-delta-normalizer.js`
   - 按 `content_block_delta.index` 分别记住 text/thinking block 当前内容。
   - 如果新 delta 是前缀增长的累计快照，只向 Java 输出 novel suffix。
   - 标准增量保持原样通过。
2. `stream-event-processor.js`
   - daemon 默认路径接入 normalizer。
3. `message-sender.js`
   - legacy channel-manager fallback 路径也接入同一 normalizer，避免 daemon fallback 后复发。
4. `stream-event-processor.test.js`
   - 新增累计 text delta 和按 block index 累计 thinking delta 回归测试。

验证：

- ✅ `node --test ai-bridge/services/claude/stream-event-processor.test.js`
- ✅ `node --test ai-bridge/config/api-config.test.js ai-bridge/services/prompt-enhancer.test.js ai-bridge/services/claude/persistent-query-service.helpers.test.mjs ai-bridge/services/claude/persistent-query-service.test.mjs ai-bridge/services/claude/session-service.test.mjs ai-bridge/services/claude/stream-event-processor.test.js`
- ✅ `node --check ai-bridge/services/claude/message-sender.js`
- ✅ `node --check ai-bridge/services/claude/stream-delta-normalizer.js`
- ✅ `node --check ai-bridge/services/claude/stream-event-processor.js`

---

## ⚠️ 2026-04-29 复盘修正（必读）

阶段 1 上线后约 1 天，用户继续反馈"内容重复闪烁"且"并非个例"。重新做了三路深度排查（ai-bridge / Java / 前端），当时结论是 **原文档对场景 B 的预案错了**。2026-04-29 用户进一步补充模型分布规律后，新增了上方“第三方模型累计 delta”根因；本节仍保留，因为前端 raw/segment 双源 race 会放大任何上游重复源。要点：

1. **阶段 1 修复落点正确**：v0.4.x 默认走 **daemon mode**（`ClaudeSDKBridge.java:365-371` daemon 优先于 channel-manager），daemon → `daemon.js` → `sendMessagePersistent` → `persistent-query-service.js` → `stream-event-processor.js`。所以 `shouldOutputMessage` 修复对默认路径用户生效。channel-manager 仅作 fallback，且 `message-sender.js:171-176` 早就有等价的 `shouldOutput` 保护，本来就没回归。
2. **阶段 2（修 Java `ReplayDeduplicator.endsWith`）的方向是错的**：阶段 1 后纯文本 turn 中 `replayContent==null`，`ReplayDeduplicator.java:75-78` 直接 inactive 返回，**根本不进 endsWith 分支**。修这条对当前用户反馈的重复闪烁完全没用。
3. **真正的根因被遗漏，且阶段 1 修复反而暴露了**它：
   - 前端 `useStreamingMessages` 的 `streamingTextSegmentsRef`（onContentDelta 累加）与 `patchAssistantForStreaming` 重建出的 `raw.message.content` blocks **是两个独立内容源**。原本被 `[MESSAGE]` 全量 snapshot 遮蔽，阶段 1 关闭这条通道后，**只剩 `[USAGE]` 等次要 backend 推送触发 `updateMessages`**，rebuild 出的 raw 长度短于 segment refs 已累积的长度。
   - `messageSync.ts` 的 `preserveStreamingAssistantContent` **只保护顶层 `.content` string，不保护 `.raw.message.content` blocks**——而 `MarkdownBlock` 渲染 blocks，于是用户看到 `ABCDE → ABC（短暂）→ ABCDEF`，正是"重复闪烁"。
   - 还有第二条独立的渲染通道：`messageCallbacks.ts:402-425` 的 rAF 节流（~16ms）与 `streamingCallbacks.ts:200-212` 的 50ms `setTimeout` 节流**完全不同步**，导致 backend snapshot 偶发"插队"在两个 delta-driven setState 之间，引发同样的 `ABCDE → ABC → ABCDEF` 时序倒灌。
4. **以下章节已据此修正**：根因排序表（L55+）、阶段 2 / 阶段 3（修复方案）、决策点（场景 B/C）。原阶段 2 内容降级保留为附录"已废弃方案"。

---

## 问题现象

用户大量反馈使用 Claude Code provider 时遇到严重的流式输出 bug：

1. **整段重复**：Markdown 表格、代码块、段落被完整重复渲染 3+ 次
2. **文本边界破坏**：出现诡异拼接，如 `import java.util.ArrayList;的！直接给您完整的Java...`

**影响范围**：Claude provider 流式模式；第三方 Claude-compatible 模型（MiniMax / GLM / Mimo 等）因为可能发送累计 delta，更容易触发

---

## 根因分析（多代理团队诊断）

### 问题链（自上而下）

```
[Anthropic SDK]
   │ 同时发出 stream_event delta + assistant 累积快照
   ▼
[ai-bridge stream-event-processor.js]              ← 🔴 重复源头
   ├─ processStreamEvent → [CONTENT_DELTA]                  (路径 A)
   ├─ processMessageContent 又算一次 delta L69-74           (路径 B 二次补发)
   └─ shouldOutputMessage 永远 true L132-134 → [MESSAGE]    (路径 C 完整快照)
   ▼
[Java ClaudeMessageHandler + ReplayDeduplicator]   ← 🔴 去重盲区
   ├─ handleAssistantMessage:270-276 conservative sync
   │  先 append 全文，再 beginContentReplay
   ├─ ReplayDeduplicator:91-93 endsWith 兜底分支
   │  无条件消费整段 delta → 真实 novel 文本被误吞
   └─ MessageMerger:316-333 preferMoreCompleteContent 取最长
      textLooksRelated 200 字符后缀重叠合并 → 不相关文本被错合
   ▼
[Webview useStreamingMessages.ts + messageSync.ts]  ← 🔴 兜底失效
   ├─ streamingContentRef += delta (无序列号去重)
   ├─ preserveStreamingAssistantContent 取较长者
   ├─ trimDuplicateTextLikeContent 仅扫描 200 字符
   │  整段表格/代码块 (>200字) 完全识别不出
   ├─ mergeStreamingTextLikeContent
   │  无 includes 关系 → 直接 left + right ← 🎯 边界破坏元凶
   └─ mergeConsecutiveAssistantMessages:849
      同 turn 多 assistant 的 raw blocks 直接 push(...) ← 🎯 整段重复元凶
```

### 根因排序（按怀疑度）

#### 初版（2026-04-28，部分错误）

| 排名 | 层 | 根因 | 严重度 |
|---|---|---|---|
| 1 | ai-bridge | `shouldOutputMessage` 永远返回 true（**回归**） | P0 |
| 2 | Java | `ReplayDeduplicator.endsWith` 兜底无条件消费 delta | P1 |
| 3 | 前端 | 200 字符重叠扫描上限 + 硬拼接兜底 | P2 |
| 4 | 前端 | 同 turn 多 assistant raw blocks 无去重 concat | P2 |

#### 复盘版（2026-04-29，以此为准）

| 排名 | 层 | 根因 | 严重度 | 复盘备注 |
|---|---|---|---|---|
| 1 | ai-bridge | `shouldOutputMessage` 永远返回 true（**回归**） | P0 | ✅ 阶段 1 已修，对 daemon mode 默认路径用户生效 |
| 2 | 前端 | `preserveStreamingAssistantContent` 仅保护 `.content`，不保护 `.raw.message.content` blocks；`[USAGE]` 触发的 `updateMessages` rebuild 出比 segment 短的 raw → React 在 `ABCDE↔ABC` 之间反复切换 | **P0** | **阶段 1 修复反而暴露此 race**；当前最高怀疑根因 |
| 3 | 前端 | tool_use turn 中 streaming buffer 与 `updateMessages` snapshot 双通道并发（与阶段 1 修复无关，固有问题） | P1 | tool_use turn 必发 [MESSAGE]，[CONTENT_DELTA] 也走过，前端两源并存 |
| 4 | 前端 | rAF 1 帧节流（messageCallbacks）与 50ms `setTimeout` 节流（onContentDelta）完全不同步，引发时序倒灌 | P1 | `ABCDE → ABC（rAF 插队）→ ABCDEF` 间歇性闪烁 |
| 5 | Java | `MessageMerger.preferMoreCompleteContent`（`MessageMerger.java:316-333`）取最长无内容关系校验 | P2 | 仅 tool_use turn 触发；放大根因 #3 |
| 6 | Java | ~~`ReplayDeduplicator.endsWith` 兜底无条件消费 delta~~ | ~~P1~~ **P3** | 阶段 1 后 `replayContent==null` 时 `ReplayDeduplicator.java:75-78` 直接 inactive 返回，**根本不进 endsWith**——修这条对当前问题无效 |
| 7 | 前端 | 200 字符重叠扫描上限 + 硬拼接兜底（`useStreamingMessages.ts`） | P2 | 文档原 P2，仍成立 |
| 8 | 前端 | 同 turn 多 assistant raw blocks 无去重 concat（`messageUtils.ts:849`） | P2 | 文档原 P2，仍成立 |

### 历史回归点

- **旧路径**（正确）：`message-sender.js:171-174` 流式 + 无 tool_use 时 `shouldOutput=false`
- **新路径**（回归）：`stream-event-processor.js:132-134` 永远 `return true`，注释写"Always output for conservative sync"
- **回归原因**：持久化通道（daemon 模式）引入时，误认为"保守同步"需要始终发 [MESSAGE]，但实际上 `processMessageContent` 的 tail-fill 机制已足够

### 路径分布（2026-04-29 复盘补充）

- **默认路径**（v0.4.x）：`DaemonBridge` → `daemon.js` → `sendMessagePersistent` → `persistent-query-service.js` → `stream-event-processor.js`。**阶段 1 修复对此路径生效**。
- **回退路径**（per-process，仅在 daemon 启动失败时用）：`channel-manager.js` → `claude-channel.js` → `message-service.js` → `message-sender.js`。`shouldOutput` 保护早就存在，无回归。
- **结论**：阶段 1 修复并非"无效"，但它解决的不是用户当前反馈的根因。真正根因已下移到前端层（见复盘版根因排序 #2~#4）。

---

## 修复方案（分层收敛）

### ✅ 阶段 1（P0）— 关闭 ai-bridge 冗余源头

**目标**：让同一段 assistant 内容只通过**一种**通道到达 Java

**改动**：
1. `ai-bridge/services/claude/stream-event-processor.js`
   - `shouldOutputMessage`: 流式 + 无 tool_use 时返回 `false`
   - 与 `message-sender.js:171-174` 行为对齐
2. `ai-bridge/services/claude/stream-event-processor.test.js`（新增）
   - 13 个测试覆盖正向/反向/端到端场景
3. `src/main/java/.../ClaudeMessageHandler.java`
   - 补注释：流式纯文本场景下 [USAGE] 是唯一权威源

**验证**：
- ✅ ai-bridge 测试 25/25 通过
- ✅ Java `ClaudeMessageHandlerDedupTest` 通过
- ✅ Tool_use 路径不受影响
- ✅ Token usage 通过 [USAGE] 独立路径
- ✅ Stream 结束信号通过 [STREAM_END] 独立路径

**Commit**: ddaa590

---

### 🟡 阶段 2（P0，**新方向**，2026-04-29 复盘后重写）— 修前端 segment vs raw blocks reconcile race

**目标**：消除"用户看到 `ABCDE → ABC（短暂）→ ABCDEF` 闪烁"的最直接根因。

**根因复述**：阶段 1 关闭了 `[MESSAGE]` 全量 snapshot 通道（针对纯文本流式 turn），但前端 `useStreamingMessages` 的 `streamingTextSegmentsRef`（onContentDelta 累加，最长）与 `patchAssistantForStreaming` 用 `buildStreamingBlocks` rebuild 的 `raw.message.content` blocks 是两个独立内容源；`[USAGE]` 等次要 backend 推送仍会触发 `updateMessages` 走 streaming 分支重建 raw，rebuild 出的 raw 短于 segment 累积值。`preserveStreamingAssistantContent` 只保护顶层 `.content` string，没保护 blocks，于是 `MarkdownBlock` 渲染出回退态。

**改动点**：

1. `webview/src/hooks/windowCallbacks/messageSync.ts` `preserveStreamingAssistantContent`（约 L190-234）
   - 在已有的 `.content` 长度比较基础上，**对 `.raw.message.content` 的 text/thinking 块也按 block index 比较长度**，取较长者保留——前端 segment 永远是真相。
2. `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts` 的 streaming 分支（约 L314-331）
   - 在调用 `patchAssistantForStreaming` 之前增加守门：当 `streamingTextSegmentsRef[active]` 已比 backend snapshot 对应 block 的 text 长时，**跳过 rebuild**（保留前端态，等下一帧），而不是用 backend 的较短值 rebuild。
3. （可选）增加 `useStreamingMessages.ts` 内一个一致性 invariant：每次 patch 后断言 `result[idx].content.length >= max(segments_active.length)`，开发模式下违反则 console.warn——尽早暴露未来回归。

**验证**：
- 单元测试：`messageSync.dedup.test.ts` 新增 case "backend updateMessages 携带短于 segment 的 raw 不应回写覆盖 blocks"。
- 手动：用一段长 markdown 表格 + Anthropic prompt caching 故意让 backend snapshot 滞后于 delta，肉眼观察是否还闪烁。

**触发条件**：当前问题（已确认）。

---

### 🟢 阶段 3（P1，**新方向**，2026-04-29 复盘后重写）— 统一 rAF + setTimeout 节流调度

**目标**：消除"backend snapshot 偶发插队在两个 delta 之间引发的时序倒灌"。

**根因复述**：`messageCallbacks.ts:402-425` 的 backend `updateMessages` 用 `requestAnimationFrame`（~16ms），`streamingCallbacks.ts:200-212` 的 `onContentDelta` 用 `setTimeout(...,~50ms)` 节流。两者完全独立，commit 落盘的顺序是不确定的。当 `T=15ms` 一个 backend snapshot 来 → 16ms 触发 rAF rebuild blocks（短）→ 50ms 触发 throttled delta（长），用户视觉上看到 `ABCDE → ABC → ABCDEF`。

**改动点**：

1. 把两条节流并入**一个共享的微任务队列**（推荐 rAF + 内部 dirty flag）：
   - `streamingCallbacks.ts` `onContentDelta` 改为只更新 `streamingTextSegmentsRef` 并 `markDirty()`，不直接调 `setUserMessages`。
   - `messageCallbacks.ts` `updateMessages` 同样只入队 backend snapshot 并 `markDirty()`。
   - 单一 rAF 在每帧 flush：先 apply backend snapshot（如果有），再叠加 segment refs 的新增部分，最后 `setUserMessages`。
2. 引入"backend snapshot 优先级低于 segment"规则：每帧 flush 时，segment 是 source of truth，backend 仅补充非 text 块（tool_use、tool_result、thinking 等）。

**验证**：
- 单元测试：模拟 `T=0/10/15/50ms` 四个事件交错，断言连续两帧 `setUserMessages` 的 text 长度单调不递减。
- E2E：关闭 daemon，强行走 channel-manager fallback，观察行为是否一致。

**触发条件**：阶段 2 上线后若仍有间歇性闪烁。

---

### 🔵 阶段 4（P3，长期，保留）— 跨层序列号机制

**目标**：彻底消除字符比较，改用序列号去重

**设计**：
- 后端为每个 delta 分配单调递增 `seq`
- 前端按 seq 严格去重，与字符内容无关
- 跨三层改动，建议在阶段 2/3 验证有效后再做

---

### ⚪ 附录 A（已废弃方案）— 修 Java 后端 endsWith 误吞（原阶段 2）

**复盘结论（2026-04-29）**：此方案对当前用户反馈的"重复闪烁"无效——阶段 1 后纯文本 turn 中 `ReplayDeduplicator.syncedContentReplay==null`，`ReplayDeduplicator.java:75-78` 直接 inactive 返回，**根本不会进入 endsWith 分支**。该 bug 仅在 tool_use turn 中可能触发，且即使触发也只表现为"漏（吃掉 novel）"，不是"凭空多出"，与"重复闪烁"现象无关。

**保留原方案以备日后**（如未来发现 tool_use turn 出现"内容缺失"才用）：

- `ReplayDeduplicator.java:91-93`
  - 增加 offset 位置校验：`replayContent.length() - delta.length() == offset` 才消费
  - 否则视为 novel
- `ClaudeMessageHandler.java:270-276`
  - 先 `beginContentReplay` 再 append，避免 offset 偏移
- `MessageMerger.java:316-333`
  - `preferMoreCompleteContent` 增加严格前缀检查（这一条仍然有意义，可能并入新阶段 2 的纵深防御）

---

## 测试策略

### 1. 单元测试（已完成）

#### ai-bridge
- `stream-event-processor.test.js`: 13 个测试
  - `shouldOutputMessage` 正向/反向场景
  - 端到端流式 + 非流式 + tool_use 组合
  - Conservative sync tail-fill 验证

#### Java（待扩充）
- `ClaudeMessageHandlerDedupTest.java`（已有）
- ~~`ReplayDeduplicatorEdgeCaseTest.java`（原阶段 2 新增）~~ — **复盘后废弃**：原阶段 2 已降级到附录 A，相关测试无意义
- `MessageMergerPreferMoreCompleteContentTest.java`（新阶段 2 纵深防御，可选）
  - tool_use turn 中 incoming/existing 不互为前缀时，不应直接取最长
  - 校验严格前缀匹配后才合并

#### 前端（**新阶段 2/3 主要测试位置**，待扩充）
- `messageSync.dedup.test.ts`（**新阶段 2 必加**）
  - case A：backend `updateMessages` 携带短于 `streamingTextSegmentsRef` 的 raw blocks → 断言 `setUserMessages` 后 `.raw.message.content[0].text` 长度不变（守住前端 segment 真相）
  - case B：[USAGE] 触发 `updateMessages` 在 onContentDelta 之间插队 → 断言 React 没有看到回退态
  - case C：>1KB 大块 Markdown 重复（保留原阶段 3 用例，仍有效）
- `streamingScheduler.test.ts`（**新阶段 3 必加**）
  - 模拟 `T=0/10/15/50ms` 四个事件交错，断言连续两帧 setUserMessages 的 text 长度单调不递减
- `mergeStreamingTextLikeContent.test.ts`（保留原阶段 3 思路，仍有效）
  - 完全包含 / 部分重叠 / 完全无关
  - 断言永不硬拼接

### 2. 集成测试（待补充）

**Fixture 录制 + 回放**：
```
ai-bridge/test/fixtures/streaming/
├── markdown-table-large.jsonl       （录制带表格的真实 SDK 输出）
├── code-block-mixed.jsonl
└── tool-use-interleaved.jsonl
```

**验证**：
- 把 fixture 喂给 mock SDK
- 断言 `process.stdout` 输出不含同一段文字 >1 次
- Java 端 mock 进程读取，断言最终 `assistantContent` 与原始 SDK message.content 字符相等

### 3. E2E 测试（待补充）

**Playwright 场景**：
```typescript
// webview/e2e/streaming-no-duplicate.spec.ts
test('long markdown table renders once', async ({ page }) => {
  // 触发返回长 Markdown 表格的 prompt
  await page.locator('.markdown-table').waitFor();
  await expect(page.locator('.markdown-table')).toHaveCount(1);
  await expect(page).toHaveScreenshot('table-baseline.png');
});
```

### 4. 运行时监控（建议）

#### Java 后端
```java
Counter.build()
  .name("replay_deduplicator_endswith_fallback_total")
  .register();
```
触发率 > 1% 应告警。

#### 前端
```typescript
if (!hasOverlap) {
  telemetry.track('streaming_hard_concat_fallback', { leftLen, rightLen });
}
```

---

## 后续步骤

### 立即行动
1. ✅ 合并 commit ddaa590 到 `feature/v0.4.1`（已完成）
2. ⏳ 观察用户反馈 1-2 天 → **观察结果：仍重复闪烁，且非个例（2026-04-29 确认）**

### 决策点（2026-04-29 复盘后更新）

**实际命中场景**：B（仍有重复，且非"零星"，是普遍存在）

**原决策的错误**：把场景 B 的预案设为"修 Java endsWith"——这条路径在阶段 1 后已不会被触发（见复盘版根因排序 #6），修了无效。

**修正后的行动顺序**：

1. **优先做新阶段 2**（前端 `preserveStreamingAssistantContent` 扩展 + `patchAssistantForStreaming` 守门）——直接消除 segment vs raw blocks reconcile race，预期能解决大部分用户反馈。
2. **若新阶段 2 上线后仍有间歇性闪烁**，继续做新阶段 3（统一 rAF + setTimeout 节流调度）。
3. **若新阶段 2/3 都做完仍有 tool_use turn 内容混乱**，再启用附录 A 的 `MessageMerger.preferMoreCompleteContent` 严格前缀校验（纵深防御）。
4. **若所有方案都不解决**，才进入"诊断有误"模式，按原场景 C 的方向排查：
   - SDK 本身 bug（升级 SDK 版本）
   - JCEF 通信层丢包/乱序
   - 前端 React 18 并发渲染问题
   - commit `0a3e523`（subscriber registry for provider updates）是否引入 callback 注册顺序回归

---

## 关键文件清单

### ai-bridge
- `ai-bridge/services/claude/stream-event-processor.js` — shouldOutputMessage 修复（阶段 1，已生效）
- `ai-bridge/services/claude/stream-event-processor.test.js` — 新增测试（阶段 1）
- `ai-bridge/services/claude/persistent-query-service.js` — executeTurn 流程（**默认 daemon 路径**）
- `ai-bridge/services/claude/message-sender.js` — 回退路径，自带 `shouldOutput` 保护（无回归）
- `ai-bridge/daemon.js` — daemon 入口，转发 `claude.send` 到 `sendMessagePersistent`
- `ai-bridge/channels/claude-channel.js` — 回退入口

### Java 后端
- `src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java` — daemon vs per-process 路由（L365-371 daemon 优先）
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java` — 消息编排
- `src/main/java/com/github/claudecodegui/session/ReplayDeduplicator.java` — 去重器（阶段 1 后纯文本 turn 空跑）
- `src/main/java/com/github/claudecodegui/session/MessageMerger.java` — 块合并（**新阶段纵深防御位置**）
- `src/test/java/com/github/claudecodegui/session/ClaudeMessageHandlerDedupTest.java` — 测试

### 前端（**新阶段 2/3 主战场**）
- `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts` — delta 累加 + 50ms `setTimeout` 节流
- `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts` — snapshot 处理 + rAF 节流（约 L402-425）+ streaming 分支 rebuild（约 L314-331）
- `webview/src/hooks/windowCallbacks/messageSync.ts` — `preserveStreamingAssistantContent`（约 L190-234，**新阶段 2 主要修改点**）
- `webview/src/hooks/useStreamingMessages.ts` — 流式状态机 + `streamingTextSegmentsRef` + `buildStreamingBlocks`
- `webview/src/utils/messageUtils.ts` — 消息合并（`mergeConsecutiveAssistantMessages` L849）
- `webview/src/components/MarkdownBlock/...` — 实际渲染 `.raw.message.content` blocks 的组件（决定为什么 `.content` 保护没用）

---

## 参考资料

- **相关 Commit**: 
  - `e6d7f49`（引入 ReplayDeduplicator 但未关闭上游源）
  - `ddaa590`（阶段 1 关闭 stream-event-processor 冗余 [MESSAGE]）
  - `b326a1a`（保留本文档的修复上下文）
  - `0a3e523`（subscriber registry for provider updates，复盘待排查是否影响 callback 注册）
- **诊断报告**: 本文档"根因分析"章节（含初版与复盘版）
- **测试覆盖**: 本文档"测试策略"章节
- **用户反馈**: GitHub Issues / 用户群聊天记录

---

## 维护者注意事项

1. **不要轻易改 shouldOutputMessage**：流式 + 无 tool_use 必须返回 false，否则重复问题会回归
2. **不要把 emitUsageTag 移到 shouldOutputMessage 后面**：[USAGE] 必须独立发出
3. **不要删除 processMessageContent 的 tail-fill 逻辑**：它是 conservative sync 的核心
4. **ReplayDeduplicator 是纵深防御**：上游修复后它应该很少触发，但不能删
5. ~~**前端 200 字符上限是已知限制**：阶段 3 会提升，但不影响阶段 1 效果~~
6. **（2026-04-29 新增）`preserveStreamingAssistantContent` 必须保护 `.raw.message.content` blocks，不只是 `.content`** —— `MarkdownBlock` 渲染的是 blocks。
7. **（2026-04-29 新增）segment refs（前端 onContentDelta 累加）是流式中的 source of truth** —— 任何 backend snapshot rebuild 都不能让前端渲染态出现"长度回退"。
8. **（2026-04-29 新增）daemon 与 channel-manager 是两条独立路径** —— 任何与流式相关的 ai-bridge 修复都要同时考虑两条路径，至少要在 PR 描述说明哪条受影响。

---

**初版**: 2026-04-28  
**复盘修正**: 2026-04-29  
**维护者**: zhukunpeng  
**审查者**: Claude Code (multi-agent team — 初版 + 2026-04-29 复盘三路并行调查)
