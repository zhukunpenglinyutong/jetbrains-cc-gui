# Daemon 串行队列状态提示设计

## 1. 目标与范围

本文档用于重设计当前 daemon 状态提示方案，目标只有一个：

- 在保持现有单 `daemon` 串行执行模型不变的前提下，让“请求已发出但尚未真正开始执行”的 Tab 获得明确提示。

本方案**不包含**以下内容：

- 不引入多 `daemon`
- 不引入并行执行
- 不重做 daemon 生命周期管理
- 不改历史恢复机制
- 不新增等待时间估算
- 不向聊天消息区插入排队系统消息

---

## 2. 现状问题

当前实现中，所有 Claude/Codex 请求都会进入同一个 `daemon.js` 串行队列：

```text
Tab -> SDKBridge -> DaemonBridge -> daemon.js -> Promise 串行队列
```

当用户点击发送后，如果当前请求前方还有未完成请求，UI 侧仍可能提前进入“正在响应”语义。这样会带来两个问题：

1. 用户无法区分“已经开始执行”和“还在等待前一个请求完成”
2. 多个 Tab 同时发送时，排队中的 Tab 容易误导用户，以为 AI 已经开始处理当前问题

而真正正常进入执行阶段时，现有逻辑已经会显示：

```text
{{provider}} 已成功连接，正在理解问题
```

这条文案本身没有问题，不需要改。

---

## 3. 设计原则

本次方案遵循以下原则：

1. **只修正等待执行阶段**
   真正开始执行后的 UI 沿用现有逻辑，不重做。

2. **最小侵入**
   仅替换当前错误出现的 loading 表现，不改消息区主内容结构。

3. **状态语义准确**
   “排队中”与“正在响应”必须互斥，不能同时出现。

4. **实现边界清晰**
   只补充队列状态事件和显示映射，不新增生命周期管理器。

---

## 4. 最终交互方案

### 4.1 Tab 标签状态

Tab 标签只保留颜色点，不显示数字、不显示图标、不显示额外文案。

颜色语义：

- 橙点：当前 Tab 对应请求已发出，但仍在等待执行
- 蓝点：当前 Tab 对应请求已真正开始执行
- 绿点：当前 Tab 本轮流式输出已完毕，任务完成通知已到达
- 默认态：当前 Tab 无活动请求

### 4.2 等待执行时的显示

当请求已经发出，但仍在 daemon 串行队列中等待时：

- 不显示现有的“正在响应” loading
- 不显示 `{{provider}} 已成功连接，正在理解问题`
- 不在聊天消息区插入系统提示文案
- 只在**原本 loading 所在位置**显示一个排队胶囊：

```text
排队中（前方 N 个）
```

其中：

- `N` 必须由当前串行队列实时计算
- `N` 表示当前请求前方尚未执行完成的请求数
- `N` 不能写死为固定值

示意：

```text
[橙点] Claude 2

User: 帮我梳理一下这段重试逻辑该怎么重构。

[排队中（前方 1 个）]
```

### 4.3 真正开始执行时的显示

当 daemon 真正取出当前请求并开始执行后：

- 排队胶囊立即消失
- Tab 标签橙点切换为蓝点
- 恢复现有执行中逻辑
- 继续显示现有文案：

```text
{{provider}} 已成功连接，正在理解问题
```

也就是说，本次改动**只覆盖等待执行阶段**，执行阶段完全复用已有 UI。

---

## 5. 状态模型

本方案不再使用旧文档中的 `TabState`/`DaemonLifecycleManager` 设计。

实际只需要 3 个显示状态：

```java
public enum QueueDisplayState {
    NONE,        // 无活动请求
    QUEUED,      // 已发出但未开始执行
    PROCESSING,  // 已开始执行，沿用现有逻辑
    COMPLETED    // 流式输出完毕，任务完成通知后
}
```

状态切换规则：

1. 用户点击发送
2. 若请求进入 daemon 后发现前方仍有未完成请求：
   `NONE -> QUEUED`
3. 当 daemon 真正开始处理当前请求：
   `QUEUED -> PROCESSING`
4. 当流式输出完毕且任务完成通知已到达：
   `PROCESSING -> COMPLETED`
5. 完成态展示结束、用户再次操作或状态被重置时：
   `COMPLETED -> NONE`
6. 请求失败 / 取消：
   `QUEUED or PROCESSING -> NONE`

`QUEUED`、`PROCESSING`、`COMPLETED` 必须互斥。

---

## 6. 事件协议设计

### 6.1 设计目标

在不改变现有串行 Promise 队列模型的前提下，daemon 只需要补充两个关键事实：

- 当前请求是否仍在等待执行
- 当前请求是否已开始执行

### 6.2 事件格式

建议沿用当前 daemon 事件通道，统一走：

```json
{ "type": "daemon", "event": "..." }
```

新增事件如下：

```json
{ "type": "daemon", "event": "queue_waiting", "requestId": "123", "aheadCount": 1 }
{ "type": "daemon", "event": "queue_started", "requestId": "123" }
{ "type": "daemon", "event": "queue_cleared", "requestId": "123" }
```

语义说明：

- `queue_waiting`
  当前请求已进入队列，但前方仍有 `aheadCount` 个请求未完成
- `queue_started`
  当前请求已被 daemon 取出，正式开始执行
- `queue_cleared`
  当前请求已结束、失败或被取消，用于兜底清理显示状态

### 6.3 文案映射

收到 `queue_waiting` 后，UI 文案为：

```text
排队中（前方 N 个）
```

其中 `N = aheadCount`

`aheadCount` 由 daemon 在请求进入等待态时计算得出，表示当前请求前方的待执行请求数，而不是固定文案占位。

不做秒数估算，不展示预计等待时间。

---

## 7. 前后端集成设计

### 7.1 daemon.js

保留当前单队列实现，不改为数组调度器，也不引入并发。

只在现有入队和开始执行节点补发事件：

1. 请求入队后，如果前方已有请求，发送 `queue_waiting`
2. 当前请求真正开始 `processRequest` 前，发送 `queue_started`
3. 请求结束后，发送 `queue_cleared`

### 7.2 DaemonBridge

扩展现有 daemon event 分发能力，让 `queue_waiting` / `queue_started` / `queue_cleared` 也能被 Java 侧监听。

这里不新增单独的 `QueueStatusNotifier` 通道，直接复用已有 daemon event listener 机制，避免协议分裂。

### 7.3 请求与 Tab 的映射

发送请求时，需要记录：

```text
requestId -> 当前 Tab / 当前窗口实例
```

这样在收到 daemon 事件时，才能把状态准确推回对应 Tab。

建议增加一个轻量级状态登记组件，例如：

```java
QueueRequestRegistry
```

职责仅包括：

- 登记本次请求属于哪个 Tab
- 根据 `requestId` 查询对应 Tab
- 请求结束后清理映射

该组件不参与调度，不参与生命周期管理。

### 7.4 ChatWindowDelegate / ClaudeChatWindow

UI 侧只需要完成两件事：

1. 更新 Tab 标签颜色点
2. 更新原 loading 区域的显示

显示规则：

- `QUEUED`
  在原 loading 位置显示：
  `排队中（前方 N 个）`
- `PROCESSING`
  恢复现有 loading / 已连接 / 正在理解问题逻辑
- `COMPLETED`
  不改变聊天区主内容，仅将 Tab 标签点切换为绿色，用于表示本轮任务已完成
- `NONE`
  清理排队胶囊和额外标记

### 7.5 i18n 文案

现有文案：

```text
{{provider}} 已成功连接，正在理解问题
```

保持不变。

新增一个排队文案键即可，例如：

```json
"queueWaiting": "排队中（前方 {{count}} 个）"
```

---

## 8. 草图确认结果

本设计对应的最终草图文件：

- [c-variant-v3.html](../.superpowers/brainstorm/queue-status-sketch/c-variant-v3.html)

草图结论：

1. 只新增等待执行阶段的排队胶囊
2. 胶囊直接替换原 loading 所在位置
3. 正常执行路径不改
4. Tab 标签只保留颜色点

---

## 9. 文件改动清单

建议改动范围控制在以下文件：

| 文件 | 改动内容 |
|------|---------|
| `ai-bridge/daemon.js` | 补充 `queue_waiting / queue_started / queue_cleared` 事件 |
| `src/main/java/.../provider/common/DaemonBridge.java` | 解析并分发新增 daemon 事件 |
| `src/main/java/.../provider/claude/ClaudeSDKBridge.java` | 暴露队列事件监听复用入口 |
| `src/main/java/.../provider/codex/CodexSDKBridge.java` | 暴露队列事件监听复用入口 |
| `src/main/java/.../session/SessionSendService.java` | 发送时建立 `requestId -> Tab` 映射 |
| `src/main/java/.../ui/ChatWindowDelegate.java` | loading 区域在 `QUEUED/PROCESSING` 间切换 |
| `src/main/java/.../ui/toolwindow/ClaudeChatWindow.java` | Tab 标签颜色点更新 |
| `webview/src/i18n/locales/zh.json` | 新增排队胶囊文案 |

如实现中需要，也可以新增一个小型状态登记类，例如：

- `QueueRequestRegistry.java`

---

## 10. 明确废弃的旧方案内容

旧版文档中的以下内容不再采用：

- `DaemonLifecycleManager`
- `MAX_CONCURRENT_DAEMONS`
- `Semaphore`
- per-tab daemon 会话设计
- `restoreSession()` 新抽象
- `TabState.CREATED / ACTIVE / TASK_RUNNING / DESTROYING`
- 顶部聊天区独立状态条
- 排队时间估算
- 历史恢复延迟与 token 压缩作为本方案核心内容

这些内容与当前目标无关，且会扩大改动范围。

---

## 11. 测试建议

### 11.1 核心场景

1. 单请求直接执行
   不出现排队胶囊，直接沿用现有已连接/理解问题逻辑

2. 多 Tab 同时发送
   首个执行中的 Tab 显示原有执行逻辑
   后续等待中的 Tab 显示：
   `排队中（前方 N 个）`

   并且 `N` 会随着前方排队数量变化而对应不同请求实际值，不允许始终显示 `1`

3. 队列推进
   前一个请求完成后，下一个等待中的 Tab：
   橙点 -> 蓝点
   排队胶囊 -> 现有执行中提示

4. 流式输出完成
   当前 Tab 在任务完成通知后：
   蓝点 -> 绿点

5. 请求取消 / 中断
   排队胶囊正确消失
   Tab 标签状态恢复默认

6. 请求失败
   不残留排队胶囊或错误颜色点

### 11.2 边界场景

1. 请求进入队列后，用户切换 Tab
   非当前活跃 Tab 仍应保留颜色点状态

2. 请求开始执行时，当前窗口发生刷新或重载
   不应长期停留在排队状态

3. daemon 异常退出
   所有关联请求状态应兜底清理

---

## 12. 结论

本方案的本质是：

> 不改变当前单 daemon 串行模型，只把“尚未真正开始执行”的错误 loading 提示，替换为准确的排队胶囊。

最终用户可见变化只有两点：

1. 等待执行时，显示：
   `排队中（前方 N 个）`
2. Tab 标签增加三态颜色点：
   橙色 = 排队中
   蓝色 = 正在执行中
   绿色 = 流式输出完毕，任务完成通知后

除此之外，现有 `{{provider}} 已成功连接，正在理解问题` 和执行中路径保持不变。
