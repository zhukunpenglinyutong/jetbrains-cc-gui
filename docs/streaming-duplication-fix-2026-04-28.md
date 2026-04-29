# 流式输出重复渲染问题分析与修复记录

**日期**: 2026-04-28  
**版本**: v0.4.1  
**状态**: 阶段 1 已完成，待观察用户反馈  
**Commit**: ddaa590

---

## 问题现象

用户大量反馈使用 Claude Code provider 时遇到严重的流式输出 bug：

1. **整段重复**：Markdown 表格、代码块、段落被完整重复渲染 3+ 次
2. **文本边界破坏**：出现诡异拼接，如 `import java.util.ArrayList;的！直接给您完整的Java...`

**影响范围**：仅 Claude provider 流式模式，长 Markdown 内容（>200 字符）

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

| 排名 | 层 | 根因 | 严重度 |
|---|---|---|---|
| 1 | ai-bridge | `shouldOutputMessage` 永远返回 true（**回归**） | P0 |
| 2 | Java | `ReplayDeduplicator.endsWith` 兜底无条件消费 delta | P1 |
| 3 | 前端 | 200 字符重叠扫描上限 + 硬拼接兜底 | P2 |
| 4 | 前端 | 同 turn 多 assistant raw blocks 无去重 concat | P2 |

### 历史回归点

- **旧路径**（正确）：`message-sender.js:171-174` 流式 + 无 tool_use 时 `shouldOutput=false`
- **新路径**（回归）：`stream-event-processor.js:132-134` 永远 `return true`，注释写"Always output for conservative sync"
- **回归原因**：持久化通道（daemon 模式）引入时，误认为"保守同步"需要始终发 [MESSAGE]，但实际上 `processMessageContent` 的 tail-fill 机制已足够

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

### 🟡 阶段 2（P1，待定）— 修 Java 后端 endsWith 误吞

**目标**：修复 `ReplayDeduplicator` 的 `endsWith` 兜底分支误吞 novel delta

**改动点**：
- `ReplayDeduplicator.java:91-93`
  - 增加 offset 位置校验：`replayContent.length() - delta.length() == offset` 才消费
  - 否则视为 novel
- `ClaudeMessageHandler.java:270-276`
  - 先 `beginContentReplay` 再 append，避免 offset 偏移
- `MessageMerger.java:316-333`
  - `preferMoreCompleteContent` 增加严格前缀检查

**触发条件**：阶段 1 观察 1-2 天后，若仍有零星重复

---

### 🟢 阶段 3（P2，可选）— 前端兜底加固

**目标**：提升前端去重能力作为最终兜底

**改动点**：
- `useStreamingMessages.ts:156-171`
  - 移除 `mergeStreamingTextLikeContent` 的硬拼接兜底
  - 改为：无包含/重叠关系时取较长一方
- `useStreamingMessages.ts:173-227`
  - `trimDuplicateTextLikeContent` 重叠扫描上限从 200 字符提到 2KB
  - 或改用 rolling hash / SHA1 段哈希全长度匹配
- `messageUtils.ts:849`
  - `mergeConsecutiveAssistantMessages` 按 block.text 哈希去重
- `streamingCallbacks.ts:164`
  - 引入 chunk seq，重复 seq 跳过

**触发条件**：下个版本，作为纵深防御

---

### 🔵 阶段 4（P3，长期）— 跨层序列号机制

**目标**：彻底消除字符比较，改用序列号去重

**设计**：
- 后端为每个 delta 分配单调递增 `seq`
- 前端按 seq 严格去重，与字符内容无关
- 跨三层改动，建议在阶段 1-3 验证有效后再做

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
- `ReplayDeduplicatorEdgeCaseTest.java`（阶段 2 新增）
  - 夹杂 delta 的 snapshot 序列
  - endsWith 误命中场景
  - text 块被 tool_use 切分

#### 前端（待扩充）
- `mergeStreamingTextLikeContent.test.ts`（阶段 3 新增）
  - 完全包含 / 部分重叠 / 完全无关
  - 断言永不硬拼接
- `messageSync.dedup.test.ts`（阶段 3 新增）
  - >1KB 大块 Markdown 重复

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
1. ✅ 合并 commit ddaa590 到 `feature/v0.4.1`
2. ⏳ 观察用户反馈 1-2 天

### 决策点（2 天后）

**场景 A：用户反馈消失**
- ✅ 阶段 1 修复有效
- 可选：进入阶段 2 精简 Java 去重逻辑（作为纵深防御）
- 阶段 3 留到下个版本

**场景 B：仍有零星重复**
- 🔍 排查第二条数据源：
  - codex-channel 是否有类似问题
  - history replay 路径（resume session）
  - 前端 rAF 节流导致的 ref 失效
- 进入阶段 2 修 Java endsWith 误吞

**场景 C：完全无改善**
- ⚠️ 说明诊断有误，重新排查
- 可能方向：
  - SDK 本身 bug（升级 SDK 版本）
  - JCEF 通信层丢包/乱序
  - 前端 React 18 并发渲染问题

---

## 关键文件清单

### ai-bridge
- `ai-bridge/services/claude/stream-event-processor.js` — shouldOutputMessage 修复
- `ai-bridge/services/claude/stream-event-processor.test.js` — 新增测试
- `ai-bridge/services/claude/persistent-query-service.js` — executeTurn 流程
- `ai-bridge/services/claude/message-sender.js` — 旧路径参考

### Java 后端
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java` — 消息编排
- `src/main/java/com/github/claudecodegui/session/ReplayDeduplicator.java` — 去重器
- `src/main/java/com/github/claudecodegui/session/MessageMerger.java` — 块合并
- `src/test/java/com/github/claudecodegui/session/ClaudeMessageHandlerDedupTest.java` — 测试

### 前端
- `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts` — delta 累加
- `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts` — snapshot 处理
- `webview/src/hooks/windowCallbacks/messageSync.ts` — 同步逻辑
- `webview/src/hooks/useStreamingMessages.ts` — 流式状态机
- `webview/src/utils/messageUtils.ts` — 消息合并

---

## 参考资料

- **相关 Commit**: e6d7f49 (引入 ReplayDeduplicator 但未关闭上游源)
- **诊断报告**: 本文档"根因分析"章节
- **测试覆盖**: 本文档"测试策略"章节
- **用户反馈**: GitHub Issues / 用户群聊天记录

---

## 维护者注意事项

1. **不要轻易改 shouldOutputMessage**：流式 + 无 tool_use 必须返回 false，否则重复问题会回归
2. **不要把 emitUsageTag 移到 shouldOutputMessage 后面**：[USAGE] 必须独立发出
3. **不要删除 processMessageContent 的 tail-fill 逻辑**：它是 conservative sync 的核心
4. **ReplayDeduplicator 是纵深防御**：上游修复后它应该很少触发，但不能删
5. **前端 200 字符上限是已知限制**：阶段 3 会提升，但不影响阶段 1 效果

---

**最后更新**: 2026-04-28  
**维护者**: zhukunpeng  
**审查者**: Claude Code (multi-agent team)
