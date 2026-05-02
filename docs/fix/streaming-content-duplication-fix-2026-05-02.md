# 流式内容重复问题修复设计文档

**日期**: 2026-05-02  
**版本**: v0.4.1  
**分支**: feature/v0.4.1-fix-streaming-duplication  
**基线**: feature/v0.4.1  
**状态**: 设计阶段

---

## 问题概述

### 症状
- **核心问题**：AI 回复内容在流式输出时出现重复
- **具体表现**：
  - 整段内容重复输出 2-3 次
  - 长文本（表格、代码块）特别容易出现
  - 重新加载 session 后重复消失 → 问题在实时流式处理层
- **影响范围**：Claude provider 流式模式

### 受影响的 Session ID
- `b6278e8a-d85c-4407-b6c4-6cf24ac53e53`
- `74003a9f-5650-4b28-9760-e2a9b542f3fd`

### 相关历史修复
- commit f8a1db1e: "fix: fix streaming reconcile race in messageSync and bump version to Alpha5"
- commit ef35c59b: "fix: normalize cumulative stream deltas to prevent content duplication"
  - 已修复 ai-bridge 层的累计 delta 问题
  - 但用户仍反馈有重复问题 → 需要继续修复

---

## 根因分析

### 问题链路

```
[Anthropic SDK]
   │ 同时发出 stream_event delta + assistant 累积快照
   ▼
[ai-bridge stream-event-processor.js]
   ├─ processStreamEvent → [CONTENT_DELTA]
   ├─ processMessageContent (二次补发)
   └─ shouldOutputMessage → [MESSAGE]
   ▼
[Java ClaudeMessageHandler + ReplayDeduplicator]
   ├─ handleAssistantMessage:270-276 conservative sync
   ├─ ReplayDeduplicator:91-93 endsWith 兜底
   └─ MessageMerger:316-333 preferMoreCompleteContent
   ▼
[Webview useStreamingMessages.ts + messageSync.ts]
   ├─ streamingContentRef += delta (无序列号去重)
   ├─ preserveStreamingAssistantContent 仅保护 .content
   ├─ mergeRawBlocksDuringStreaming 不保护 .raw blocks
   └─ mergeConsecutiveAssistantMessages:849 直接 push
```

### 根因排序（按严重度）

| 排名 | 层 | 根因 | 严重度 |
|---|---|---|---|
| 1 | 前端 | `preserveStreamingAssistantContent` 仅保护 `.content`，不保护 `.raw.message.content` blocks | P0 |
| 2 | 前端 | tool_use turn 中 streaming buffer 与 updateMessages snapshot 双通道并发 | P1 |
| 3 | 前端 | rAF 节流与 setTimeout 节流完全不同步，引发时序倒灌 | P1 |
| 4 | Java | `MessageMerger.preferMoreCompleteContent` 取最长无内容关系校验 | P2 |

---

## 解决方案设计

### 方案选择

采用**综合方案**：前端内容去重 + raw blocks 保护

**理由**：
1. 前端去重作为安全网，立即防止重复内容显示
2. raw blocks 保护从源头解决渲染问题
3. 双重保险确保用户体验

### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│              防护层次                                        │
├─────────────────────────────────────────────────────────────┤
│  第1层: 前端内容去重（安全网）                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ • onContentDelta 去重检测                            │    │
│  │ • onThinkingDelta 去重检测                           │    │
│  │ • 基于 lastProcessedContentSuffix 的快速检测          │    │
│  └─────────────────────────────────────────────────────┘    │
│                            ↓                                │
│  第2层: 前端 raw blocks 保护                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ • preserveStreamingAssistantContent 扩展             │    │
│  │ • mergeRawBlocksDuringStreaming 增强                 │    │
│  │ • patchAssistantForStreaming 守门                    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 实施计划（基于 Agent）

### 执行流程

```
阶段 2（串行）
├─ 1. code-reviewer: 审查现有代码
├─ 2. code-reviewer: 修改前端代码
├─ 3. typescript-reviewer: 审查修改
├─ 4. tdd-guide: 编写测试
└─ 5. e2e-runner: E2E 测试验证

决策点
├─ 问题解决？→ 完成
└─ 仍有问题？→ 阶段 3

阶段 3（串行，如果需要）
├─ 1. code-reviewer: 创建统一节流调度器
├─ 2. typescript-reviewer: 重构调用点
├─ 3. tdd-guide: 更新测试
└─ 4. e2e-runner: E2E 测试验证

验证与发布
├─ 1. code-reviewer: 最终审查
├─ 2. doc-updater: 更新文档
└─ 3. 合并到 feature/v0.4.1
```

### 参与者与职责

| Agent | 职责 | 并行能力 |
|-------|------|----------|
| code-reviewer | 代码审查、实施修改 | 可并行审查不同文件 |
| typescript-reviewer | TypeScript 代码审查 | 与 code-reviewer 串行 |
| tdd-guide | 测试驱动开发、编写测试 | 与实施串行 |
| e2e-runner | E2E 测试验证 | 最后执行 |
| doc-updater | 更新文档 | 并行 |

---

## 测试策略

### 单元测试

**messageSync.dedup.test.ts**（新增）
```typescript
describe('preserveStreamingAssistantContent with raw blocks', () => {
  it('应该保护 raw.message.content blocks 不被短 snapshot 覆盖');
  it('应该处理 streamingTextSegments 长于 backend snapshot 的情况');
});
```

**streamingCallbacks.dedup.test.ts**（新增）
```typescript
describe('onContentDelta deduplication', () => {
  it('应该跳过重复的 delta');
  it('应该跳过与当前内容后缀重叠的 delta');
  it('应该允许 novel delta 通过');
});
```

### E2E 测试

```typescript
test('长 markdown 表格不重复渲染', async ({ page }) => {
  await page.locator('#chat-input').fill('生成一个包含5行3列的markdown表格');
  await page.locator('#send-button').click();
  await page.waitForSelector('[data-streaming="false"]');
  
  const tableCount = await page.locator('.markdown-table table').count();
  expect(tableCount).toBe(1);
});
```

---

## 风险评估

### 技术风险

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 修改引入新 bug | 中 | 高 | 完善单元测试 + 代码审查 |
| 性能退化 | 低 | 中 | 性能基准测试 |
| 与现有功能冲突 | 低 | 中 | 回归测试 |

---

## 成功标准

### 功能指标
- ✅ 流式输出中无重复内容（视觉检测）
- ✅ 长文本（>1KB）正确渲染
- ✅ 工具调用场景无退化

### 性能指标
- ✅ 流式输出延迟 < 100ms
- ✅ 内存占用增长 < 10%

---

## 参考资料

### 相关代码文件

**前端（主战场）**：
- `webview/src/hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts`
- `webview/src/hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts`
- `webview/src/hooks/windowCallbacks/messageSync.ts`
- `webview/src/hooks/useStreamingMessages.ts`

**Java 后端**：
- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java`
- `src/main/java/com/github/claudecodegui/session/ReplayDeduplicator.java`
- `src/main/java/com/github/claudecodegui/session/MessageMerger.java`

### 相关提交
- f8a1db1e: "fix: fix streaming reconcile race in messageSync and bump version to Alpha5"
- ef35c59b: "fix: normalize cumulative stream deltas to prevent content duplication"

### 相关 Issue
- Session ID: `b6278e8a-d85c-4407-b6c4-6cf24ac53e53`
- Session ID: `74003a9f-5650-4b28-9760-e2a9b542f3fd`

---

**创建日期**: 2026-05-02  
**维护者**: Claude Code Agent Team  
**基线分支**: feature/v0.4.1  
**状态**: 待实施
