# Sub-agent Edits Status Panel 实现计划

> **For Claude:** REQUIRED SUB-SKILL：使用 `superpowers:executing-plans` 按任务逐步执行本计划。

**目标：** 让 Claude 和 Codex 的 sub-agent 产生的文件改动，能够出现在现有 `Edits` 状态面板中，并且与主 agent 改动具备同样的 diff、单文件回滚、全部丢弃、全部接受能力。

**架构：** 在 Java session 消息流水线中新增一个 provider-neutral 的 sub-agent edit 捕获层。该层在 sub-agent 启动时开启文件改动作用域，记录作用域内被触碰文件的修改前快照，在 sub-agent 完成后生成标准 `edit`/`write` 工具调用消息，再交给现有 React `useFileChanges` hook、Java diff handler 和 undo handler 处理。因为多 Agent 复审确认现有 diff/undo 成功语义存在硬风险，所以第一阶段必须同时修正 rollback、batch rollback、diff reject 的失败可观测性，不能只做展示。

**技术栈：** IntelliJ Platform Java 17 插件 API、Gson、Claude/Codex session handlers、React/TypeScript webview hooks、现有 editable diff/undo handlers、Gradle/JUnit、Vitest。

---

## 1. 当前架构分析结论

经过代码分析，现有 `Edits` 能力的核心链路如下：

1. Java provider 层把 Claude/Codex 输出转换为 `ClaudeSession.Message`，并存入 `SessionState`。
2. Java 通过已有 callback 把完整消息列表推给 webview。
3. 前端 `webview/src/hooks/useFileChanges.ts` 从 assistant message 的 `tool_use` block 中解析文件改动。
4. `useFileChanges` 只认 `FILE_MODIFY_TOOL_NAMES` 中的文件修改工具，例如 `edit`、`write`、`edit_file`、`write_file`。
5. `webview/src/components/StatusPanel/FileChangesList.tsx` 把解析出的 `FileChangeSummary.operations` 传给 diff/undo bridge。
6. `src/main/java/com/github/claudecodegui/handler/diff/EditableDiffHandler.java` 根据 operations 反推修改前内容并打开交互式 diff。
7. `src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java` 用同一组 operations 执行单文件或批量回滚。
8. `webview/src/hooks/useFileChangesManagement.ts` 的 Keep All 只移动 `baseMessageIndex`，不会改磁盘文件。

关键结论：

- `Edits` 当前不是 VCS dirty files 视图，而是“从聊天消息里的文件修改工具调用解析出的可操作改动列表”。
- 因此，正确改造点不是重写 `Edits` 面板，而是让 sub-agent 改动变成同样格式的 `edit`/`write` 工具调用消息。
- 仅合成消息不足以达成“和主 agent 一样可 diff / 回滚 / 接受”。现有 `UndoFileHandler`、`ContentRebuildUtil`、`EditableDiffHandler` 对失败和 partial success 的处理必须先变成可观测、可阻断、可返回给前端的结构化结果。
- Codex 已有 `codex_session_patch` 合成链路，新增 VFS tracker 后会形成“双真源”。必须在后端定义权威来源和去重策略，不能把 correctness 押在前端字符串 dedupe 上。
- Claude 当前可能通过 `[MESSAGE]` user tool_result 和 `[TOOL_RESULT]` 双路径触发 completion；Codex tool id 也可能因 signature 复用而不具备“每次调用唯一”语义。因此 lifecycle finalize 必须幂等，并且 provider-specific 完成信号必须经过真实 fixture 验证。

### 1.1 多 Agent 复审收敛结论

本方案经过三路 sub-agent 交叉 review 后，收敛出以下必须修正项。以下条目是本计划的阻塞验收门槛；任一未满足，都不能宣称“sub-agent 改动与主 agent 改动完全一致支持 Edits 操作”。

1. **核心捕获链路是硬阻塞。** 必须新增 session-owned `SubagentLifecycleDetector`、`SubagentEditScopeTracker`、VFS before/after snapshot、`SyntheticFileChangeMessageFactory`，并接入 Claude/Codex handlers；只修前端展示或只加 metadata 不算完成。
2. **Undo 成功语义是硬阻塞。** 单文件 rollback 找不到 `newString`、定位歧义、`safeToRollback=false`、写入/删除失败时不能 silent success；`undo_all` 部分失败时不能向前端报告整体成功并隐藏全部 Edits。
3. **Codex 双来源是硬阻塞。** 当 `codex_session_patch` 已覆盖某个文件/operation 时，VFS tracker 只能补缺，不能再生成并列权威 operation；后端必须有 operation registry/source priority，前端 dedupe 只能兜底。
4. **Lifecycle completion 必须幂等。** Claude 双通道 tool_result、Codex wait/close 重复或缺失信号都必须被 `scopeId + completionToken` 去重处理；同一次 finalize 只能 append 一批 synthetic messages。
5. **Claude mixed tool_result 必须过滤。** 一个 user message 同时包含“已处理 tool_result”和“新 tool_result”时，不能把整条 raw message 原样再次加入历史；必须只保留未处理 blocks 或拆分后追加。
6. **Codex lifecycle id 必须唯一。** `spawn_agent` / `wait_agent` / `close_agent` / `send_input` / `resume_agent` 等 lifecycle tools 必须优先使用 raw `payload.call_id` 或 MCP `item.id`；缺少唯一 id 时必须生成 sequence id 或 fail-closed，不能用 signature 复用吞掉重复调用。
7. **不明确就失败关闭。** 无法可靠归属 agent、无法获取 before snapshot、文本重复且无法安全定位、文件已被用户改写时，不生成可 rollback operation。
8. **Keep All 不能跨 pending scope 生效。** 前端可以用 message boundary 隐藏已展示 edits，但必须在 streaming 或 Codex/Claude pending sub-agent scope 未 flush 时禁用；不得使用跨来源不可比的单一 `edit_sequence` 水位过滤未来消息。
9. **Discard All 必须按请求快照隐藏。** `undo_all` 成功或 partial success 后，前端只能隐藏后端返回的 `succeededFiles` 或请求发起时的文件快照，不能按“当前面板最新列表”全量隐藏，否则会误处理延迟 synthetic injection。
10. **新增文件删除必须验证真实磁盘状态。** 回滚 added file 时必须 refresh VFS，并在 VFS 找不到时使用 filesystem fallback；如果磁盘文件仍存在且删除失败，必须返回失败。
11. **Simple diff 也必须使用结构化失败。** 不只 editable diff，`SimpleDiffDisplayHandler` / `ContentRebuildUtil` 的 before-content rebuild 失败也必须可观测，不能 silent skip。

---

## 2. 非目标

本功能不做以下事情：

- 不把 `Edits` 改成单纯读取 `git diff` 或 IDE dirty files。
- 不为 Claude 和 Codex 做两套不同 UI。
- 不依赖 sub-agent 最终总结文本来猜测改了哪些文件。
- 不在缺少 before snapshot 的情况下强行生成可回滚操作。
- 不在第一阶段新增删除文件状态 `D`，因为当前主 agent pipeline 也没有完整支持删除文件展示/恢复。
- 不改变现有主 agent edit/write 的行为。

---

## 3. 推荐总体方案

### 3.1 核心思路

新增一个 `SubagentEditScopeTracker`。注意：当前 `SessionSendService` 每次发送都会创建新的 `ClaudeMessageHandler` 或 `CodexMessageHandler`，所以 tracker 不能是 handler-local 对象。它必须是 session-owned collaborator，由 `SessionSendService` 持有并注入 Claude/Codex handlers，或者挂在 `SessionState` 附近由 session 生命周期统一管理。否则 Codex `spawn_agent` 跨 `wait_agent`、跨消息阶段时会丢 scope。

```text
Claude/Codex 消息流
        |
        v
ClaudeMessageHandler / CodexMessageHandler
        |
        +-- SubagentLifecycleDetector 识别 Task/agent/spawn_agent 启动与完成
        |
        v
SubagentEditScopeTracker
        |
        +-- sub-agent 启动时打开 scope
        +-- scope 活跃期间记录文件 before snapshot
        +-- scope 完成时刷新并读取 after content
        +-- before/after 生成 edit/write operations
        |
        v
Synthetic assistant tool_use + user tool_result messages
        |
        v
现有 useFileChanges -> StatusPanel Edits
        |
        +-- 加固后的 diff
        +-- 加固后的单文件回滚
        +-- 加固后的全部丢弃
        +-- pending-scope gate + message boundary 版全部接受
```

### 3.2 为什么要合成消息

现有 `Edits` 的数据契约是：

```json
{
  "type": "tool_use",
  "name": "edit",
  "input": {
    "file_path": "/absolute/path/File.java",
    "old_string": "before hunk",
    "new_string": "after hunk",
    "replace_all": false
  }
}
```

如果 sub-agent 改动也被转换成这种结构，现有前端和后端几乎不需要知道“这是 sub-agent 改的”。它只会把这些操作当成普通文件改动。

推荐 synthetic edit message 格式：

```json
{
  "type": "assistant",
  "content": "",
  "raw": {
    "isMeta": true,
    "message": {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "subagent_edit_<scopeId>_<sequence>_<index>",
          "name": "edit",
          "input": {
            "file_path": "/absolute/path/File.java",
            "old_string": "before hunk",
            "new_string": "after hunk",
            "replace_all": false,
            "start_line": 42,
            "end_line": 48,
            "source": "subagent",
            "scope_id": "<scopeId>",
            "agent_handle": "<provider-stable-handle-if-known>",
            "parent_tool_use_id": "<task-or-spawn-tool-id>",
            "operation_id": "<globally-unique-operation-id>",
            "safe_to_rollback": true
          }
        }
      ]
    }
  }
}
```

并追加匹配的 synthetic tool result：

```json
{
  "type": "user",
  "content": "",
  "raw": {
    "isMeta": true,
    "message": {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "subagent_edit_<scopeId>_<sequence>_<index>",
          "is_error": false,
          "content": "Sub-agent edit captured"
        }
      ]
    }
  }
}
```

新文件使用 `write`：

```json
{
  "type": "tool_use",
  "id": "subagent_write_<scopeId>_<sequence>_<index>",
  "name": "write",
  "input": {
    "file_path": "/absolute/path/NewFile.java",
    "content": "full file content",
    "new_string": "full file content",
    "source": "subagent",
    "scope_id": "<scopeId>",
    "agent_handle": "<provider-stable-handle-if-known>",
    "operation_id": "<globally-unique-operation-id>",
    "safe_to_rollback": true
  }
}
```

注意事项：

- `ClaudeSession.Message.content` 必须为空字符串；不要写 `Tool: edit` 之类可见文本，否则会污染聊天区并干扰 tool-only message 判定。
- synthetic messages 的 `raw.isMeta` 必须为 `true`，用于和真实模型输出区分；metadata 同时必须放在 `tool_use.input` 内，因为前端 `useFileChanges` 只从 normalized tool input 读取文件改动元数据。
- 同一个 scope finalize 时，推荐生成一条 assistant message，内部包含多个 `tool_use` block；再生成一条 user message，内部包含对应多个 `tool_result` block。这样能减少消息数量，也能让同一批 synthetic operations 更稳定。
- `tool_use.id` 必须全局唯一，不能只依赖 provider 原始 `tool_use_id`；建议包含 `scopeId + finalizeSequence + operationIndex`。

---

## 4. Claude 和 Codex 支持策略

### 4.1 Claude

Claude sub-agent 通常通过 `Task` 或 `agent` 工具调用体现。

生命周期规则：

- assistant `tool_use` 的 normalized name 为 `task` 或 `agent` 时，开启一个 sub-agent scope。
- 收到匹配 `tool_use_id` 的 user `tool_result` 时，完成该 scope。
- completion 处理必须按 `scopeId + parentToolUseId + completionToken` 幂等；同一个 completion 被 `[MESSAGE]` user tool_result 和 `[TOOL_RESULT]` tag 同时送达时，只能 finalize 一次。
- 如果 streaming/turn 结束时还有未完成 scope，只能 finalize 明确可关闭的 Claude scope；无法确认结束语义的 scope 应保留 pending 或 fail-closed，不生成可 rollback operation。

Claude raw message 去重规则：

- `ClaudeMessageHandler` 不能只维护一个 `processedToolResultIds` 后直接跳过整条消息。user message 可能同时包含多个 `tool_result` block，其中一部分已通过 `[TOOL_RESULT]` 通道处理，另一部分是新的。
- 处理 user raw message 前先按 block 过滤：已处理 `tool_result.id/tool_use_id` 从 raw content 中移除；未处理 blocks 保留并继续触发 lifecycle completion。
- 如果过滤后 raw content 为空，不追加该 user message；如果仍有普通文本或未处理 blocks，则追加过滤后的 clone，不能把已处理 block 再暴露给前端。
- synthetic append 必须由统一 completion 入口触发，不能分别在 `[MESSAGE]` 和 `[TOOL_RESULT]` 两条路径各自 append。

Claude 主 agent 的 `Edit`/`Write` 工具调用不需要改造，继续走现有链路。

### 4.2 Codex

Codex 有两个相关路径：

1. 主 agent 的 `apply_patch`/file_change：当前 `ai-bridge/services/codex/codex-event-handler.js` 已经能从 session patch 合成 `edit`/`write` 操作，并标记为 `source=codex_session_patch`。
2. sub-agent：通常通过 `spawn_agent` 启动，再通过 `wait_agent` 或 `close_agent` 等待/关闭。

Codex 生命周期规则：

- 看到 assistant `tool_use` name 为 `spawn_agent` 时，创建 provisional scope。
- scope 关联字段不要命名为单一 `agentId`。应使用 provider-neutral 的 `agentHandle`，并从 `agent_id`、`agentId`、`agent_path`、`agentPath`、文本 UUID、返回对象 id 等真实输出里提取。
- scope 在 `spawn_agent` 返回后继续保持 active，因为 worker 后续还可能继续修改文件；不能沿用当前 `useSubagents` “spawn tool_result 就 completed”的 UI 语义来判断文件 scope 完成。
- 看到 `wait_agent` 或 `close_agent` 的成功结果时：
  - 如果能通过 `target` / `agentHandle` / `parent_tool_use_id` 匹配 active scope，则 finalize 对应 scope。
  - 如果无法可靠匹配，不能 finalize 最早 active scope；必须 fail-closed，保留 pending 诊断日志，或者只生成不可 rollback 的展示项。
- detector 必须维护 session-owned `toolUseId -> toolName/input` 映射，因为 user `tool_result` 只有 `tool_use_id`，不包含原始工具名；这个映射不能放在 `CodexMessageHandler` 实例上。
- 如果 lifecycle 依赖 `wait_agent`/`close_agent` 的每次调用唯一性，必须先修正 `ai-bridge` 对这些 lifecycle tools 的 `tool_use_id` signature 复用 / `tool_result` 去重策略，或者新增不被去重吞掉的 lifecycle sequence event。
- turn completion 只能作为“flush 明确已完成 scope”的机会，不能无条件 finalize 所有 active Codex scope。

Codex Node bridge lifecycle 契约：

- 对 `spawn_agent`、`wait_agent`、`close_agent`、`send_input`、`resume_agent`，`ai-bridge` 必须优先使用 raw `payload.call_id`；MCP item/event path 必须优先使用 `item.id`，不能先用 `findMatchingToolUseId` 做 signature 匹配。
- 只有非 lifecycle 普通工具才允许 signature fallback。lifecycle tool 缺少 raw id 时，必须生成包含 monotonic sequence 的 synthetic id，例如 `codex_lifecycle_<toolName>_<sequence>`，并把 sequence 透传给 Java；不能把相同 args 的重复 `wait_agent` 合并成同一个 tool_use。
- lifecycle `tool_result` 必须可追溯到唯一 tool_use。空结果、错误结果、重复 wait/close 都要发出可诊断 event；Java 层根据 result 成败决定 finalize / fail-closed。
- 必须用 fixture 覆盖 raw `call_id`、无 `call_id`、MCP `item.id`、重复 `wait_agent` 同 args、重复 `close_agent`、缺失 result、错误 result 这七类场景。

Codex 双来源规则：

- 不要删除现有 Codex main patch synthesis。
- 后端必须定义单一权威来源：同一文件已有 `codex_session_patch` 覆盖时，VFS tracker 默认不再生成同文件 operations，只允许补充 session patch 缺失的文件。
- 新增 session-owned `EditOperationRegistry`，在 synthetic message append 前登记 `operationId`、`filePath`、normalized hunk hash、line range、source、scopeId、finalizeSequence。
- source priority 固定为：`codex_session_patch` > `main_tool_use` > `subagent_vfs`。priority 只用于折叠同一路径/同一 hunk 的重复来源；不同 hunk 不得互相覆盖。
- VFS tracker 发现与高优先级 operation 同路径同 hunk 时，只写 diagnostic，不生成第二个可回滚 operation；发现同路径不同 hunk 时可以生成补充 operation，但必须带独立 `operationId`。
- dedupe 应先在后端按 `operationId` / normalized hunk / file path / source priority 完成；前端 dedupe 只能作为防御层，不能承担 correctness。
- 必须用真实 Codex event/session fixture 验证：主 agent patch 不重复、worker patch 归属正确、wait/close 重复或缺失时不会错误 finalize。

---

## 5. 文件改动捕获策略

### 5.1 主策略：作用域内 VFS 快照

实现 `SubagentEditScopeTracker`，在有 active scope 时订阅 IntelliJ VFS 事件。

推荐使用：

- `project.getMessageBus().connect()`
- `VirtualFileManager.VFS_CHANGES`
- `BulkFileListener.before(...)`
- `BulkFileListener.after(...)`

线程与性能约束：VFS 回调可能发生在敏感线程或写动作附近，读取 before content 时必须设置文件大小上限，跳过二进制/超大文件，并避免在 EDT 上做昂贵 diff。diff 构建和 synthetic message 生成应放在 finalize 阶段的后台流程中完成；最终 append message 再回到 session 消息处理链路。

scope 数据结构建议：

```java
final class SubagentEditScope {
    String scopeId;
    String provider; // claude | codex
    String parentToolUseId;
    String agentHandle;
    long finalizeSequence;
    Set<String> completedTokens;
    long startedAtMillis;
    boolean finalizing;
    Map<String, FileSnapshot> beforeByPath;
    Set<String> touchedPaths;
    Set<String> skippedPaths;
}

final class FileSnapshot {
    String path;
    boolean existed;
    boolean binary;
    String content;
    long length;
    long modifiedAtMillis;
    String contentHash;
}

final class RegisteredEditOperation {
    String operationId;
    String filePath;
    String source; // main_tool_use | subagent_vfs | codex_session_patch
    String scopeId;
    long finalizeSequence;
    int lineStart;
    int lineEnd;
    String normalizedHunkHash;
}
```

处理规则：

- scope start 时立即捕获 project snapshot，作为后续 before content 的唯一可信基线。
- scope start 后开始监听 VFS touched path。
- 文件创建时，优先使用 scope-start snapshot 判断 `existed=false`；如果无法证明 before content，则 fail-closed 跳过可回滚 operation。
- 文件修改后，仅记录 touched path，不在事件发生后反读磁盘作为 before content，避免把 after content 误当作 before content。
- finalize 前主动刷新 project root，避免外部 Node/Codex 进程写入后 VFS 还没同步。
- completion signal 到达后不要立即同步读文件；应做稳定性探测：刷新 VFS 后读取 size/mtime，间隔短延迟再次读取，连续两次稳定或达到超时后再读取 after content。固定 300-1000ms debounce 只能作为兜底，不应是唯一机制。
- finalize 时读取 after content，并用 before/after 生成 operations。
- finalize 生成 operation 前先查询 session-owned `EditOperationRegistry`：只有同一路径、同一 normalized hunk、同一 before/after 语义的 operation 才按 source priority 去重；同路径不同 hunk 必须保留为独立 operation。
- registry 不允许做 path-level suppression；否则主 agent 和 sub-agent 修改同一文件不同区域时会误丢合法改动。
- 如果文件在 finalize 前又被用户手动修改、IDE document 仍有未保存内容，或同一文件被多个 active scopes 同时触碰且无法区分归属，则跳过可 rollback operation。
- 对 Codex，`codex_session_patch` 只压制同 hunk 的重复 VFS operation；同一路径不同 hunk 仍可由 VFS tracker 补充。
- 所有 skipped path 必须进入 diagnostic log，包含 `scopeId`、`agentHandle`、`path`、`reason`，便于后续排查“sub-agent 明明改了文件但 Edits 没显示”的情况。

### 5.2 兜底策略：dirty file reconciliation

VFS 是主策略，但为了处理外部进程写入未及时触发 VFS 的情况，可以加一个保守兜底：

1. scope start 时，如果项目是 Git repo，记录当前 dirty file set。
2. scope finalize 时，再记录一次 dirty file set。
3. 只处理“scope 期间从 clean 变 dirty”的文件。
4. tracked 文件可以从 `HEAD` 读取 before content，但仅限 scope start 时确实 clean 的文件。
5. untracked 新文件 before content 为空。
6. 如果文件在 scope start 时已经 dirty，且 VFS 没有捕获 before snapshot，则跳过，不生成可回滚操作。

这个兜底策略的原则是：宁可不展示，也不要生成可能误回滚用户已有改动的危险操作。

---

## 6. Operation 生成规则

新增 `EditOperationBuilder`，输入 before/after content，输出可被现有 `useFileChanges`、`EditableDiffHandler`、`UndoFileHandler` 消费的 operations。

### 6.1 支持场景

- 已存在文本文件被修改：生成一个或多个 `edit` operations。
- 新文本文件被创建：生成一个 `write` operation。
- 文件创建后又在 scope 结束前被删除：不生成 operation。
- 文件修改后又恢复原样：不生成 operation。
- 二进制文件：跳过并写 debug log。
- 超大文件：默认跳过，除非能安全生成小范围 hunk。

### 6.2 Diff 算法

建议实现 line-based diff：

1. 按行切分 before/after，同时保留行尾换行信息。
2. 对合理大小文件使用 LCS 或 Myers diff。
3. 合并距离很近的 hunks。
4. 每个 hunk 带 2-3 行上下文，降低 `newString` 在文件中重复匹配导致回滚错位置的概率。
5. 记录 `start_line`、`end_line`，用于文件跳转和后续 line-aware rollback。

不要默认对修改文件生成 whole-file operation。whole-file operation 虽然简单，但会让回滚风险显著变高，尤其是文件在 scope 前已经 dirty 或用户同时编辑时。

### 6.3 删除文件

当前 `FileChangeStatus` 只有 `A` 和 `M`。删除文件应作为后续增强，不放入第一阶段：

- 增加 `D` 状态。
- 前端 `FileChangesList` 支持删除状态展示。
- `showEditableDiff` 支持 deleted file diff。
- `UndoFileHandler` 支持把删除文件恢复为 old content。

第一阶段遇到删除文件时：记录日志并跳过，不展示危险操作。

---

## 7. Synthetic Message 生成规则

新增 `SyntheticFileChangeMessageFactory`。

职责：把 `EditOperationBuilder` 输出的 operations 转换为 `ClaudeSession.Message` 列表。

每个 finalized scope 生成两条隐藏 meta 消息：

1. 一条 assistant message，`content=""`，`raw.isMeta=true`，`raw.message.content` 中包含多个 `tool_use` blocks。
2. 一条 user message，`content=""`，`raw.isMeta=true`，`raw.message.content` 中包含对应多个 `tool_result` blocks。

要求：

- raw 结构要兼容 `webview/src/utils/messageUtils.ts` 的 `normalizeBlocks`。
- `tool_use.id` 与 `tool_result.tool_use_id` 必须一一对应且全局唯一。
- `tool_result.is_error` 必须为 `false`；如果 operation 不安全，不生成 successful tool result，而是在 diagnostic log 中说明跳过原因。
- metadata 必须保留在 `tool_use.input` 中，包括 `source`、`scope_id`、`agent_handle`、`parent_tool_use_id`、`operation_id`、`safe_to_rollback`、`edit_sequence`。
- `edit_sequence` 仅作为同一来源内的诊断/排序 metadata；前端 Keep All 不得把 Java tracker、Codex bridge、不同 turn 的 sequence 当成全局可比较水位。
- 同一个 scope finalize 时批量 append messages；`SubagentEditScopeTracker.complete(...)` 必须幂等，即使 handler 收到重复 completion signal，也只能返回同一批 messages 一次。
- `callbackHandler.notifyMessageUpdate(state.getMessages())` 不要求全链路只发生一次，但 synthetic append 与 completion 状态更新必须是原子语义，不能出现重复 synthetic messages。
- 不要把 metadata 只放在 `raw` 顶层；当前前端 Edits 解析不读取顶层 raw metadata。

---

## 8. 前端改造

前端应尽量保持小改动，但必须把现有操作结果协议补齐，否则 “Discard All / Reject / Undo” 会错误隐藏失败项。

### 8.1 必需改动

修改 `webview/src/types/fileChanges.ts`：

```ts
export interface EditOperation {
  toolName: string;
  oldString: string;
  newString: string;
  additions: number;
  deletions: number;
  replaceAll?: boolean;
  lineStart?: number;
  lineEnd?: number;
  source?: 'main' | 'subagent' | 'codex_session_patch';
  scopeId?: string;
  agentHandle?: string;
  parentToolUseId?: string;
  operationId?: string;
  safeToRollback?: boolean;
  editSequence?: number;
}
```

修改 `webview/src/hooks/useFileChanges.ts`：

- 从 normalized input 中读取：
  - `source`
  - `scope_id`
  - `agent_handle`
  - `parent_tool_use_id`
  - `operation_id`
  - `safe_to_rollback`
  - `edit_sequence`
- 构建 `EditOperation` 时保留这些字段。
- 保留现有 `lineStart/lineEnd` 解析，并在 diff / undo bridge payload 中继续传给 Java。
- 加防御性 operation dedupe，但只作为兜底。

前端 processed/dedupe key 的优先级必须是：

```text
operationId > toolUseId > occurrenceId > filePath + toolName + oldString + newString + lineStart + lineEnd
```

其中 `operationId` 和 `toolUseId` 表示后端/bridge 已声明的唯一 operation，不得被纯文本 hunk 指纹合并；这样才能保留同一文件同一 hunk 的多次合法重复编辑。只有缺少稳定 id 的历史消息才退回到 hunk 指纹兜底。Codex session patch 与 VFS tracker 的同 hunk 重复必须主要由后端 `EditOperationRegistry` 处理，前端 dedupe 不能承担正确性职责。

修改 `webview/src/components/StatusPanel/FileChangesList.tsx`、`webview/src/components/StatusPanel/StatusPanel.tsx` 与 bridge 类型：

- `showEditableDiff`、单文件 undo、`undo_all_file_changes` 都必须传完整 operations，包括 `lineStart`、`lineEnd`、`operationId`、`source`、`scopeId`、`safeToRollback`、`editSequence`。
- `undo_all` 发起前必须捕获请求快照：`requestId + filePaths + operationIds`。后端返回 success 时也应返回 `succeededFiles`；前端只隐藏 `succeededFiles`，如果老后端未返回该字段，最多隐藏请求快照内文件，不能隐藏当前最新 Edits 列表。
- `undo_all` 返回 partial result 时，前端只把成功文件对应的 operation keys 加入 processed set；失败文件/失败 operations 继续留在 `Edits` 并展示错误提示。
- `Keep All` 设置 `baseMessageIndex = messages.length` 前必须确认没有 streaming/pending sub-agent；如果仍有 pending scope，禁用 Keep All 或先完成 synthetic injection，避免后续注入被错误接受或错误隐藏。
- `Keep All` 只移动接受边界，不修改磁盘文件，也不能复用 undo/discard 的 operation-level processed keys；不要用单一 edit sequence 阈值过滤未来 edits。

### 8.2 可选 UI

默认不显示来源标识，以满足“和主 agent 完全一样”的诉求。

如果产品上需要解释来源，可在后续增加轻量 badge：当文件任一 operation 的 `source === 'subagent'` 时显示 `Sub-agent`，但这不是 MVP 必需项。

---

## 9. 后端改造文件清单

新增：

- `src/main/java/com/github/claudecodegui/session/SubagentLifecycleDetector.java`
- `src/main/java/com/github/claudecodegui/session/SubagentEditScopeTracker.java`
- `src/main/java/com/github/claudecodegui/session/SyntheticFileChangeMessageFactory.java`
- `src/main/java/com/github/claudecodegui/session/EditOperationRegistry.java`
- `src/main/java/com/github/claudecodegui/util/EditOperationBuilder.java`
- `src/main/java/com/github/claudecodegui/util/FileSnapshotUtil.java`
- `src/main/java/com/github/claudecodegui/util/UndoOperationApplier.java`
- `webview/src/components/StatusPanel/fileChangeActions.ts`

修改：

- `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java`
- `src/main/java/com/github/claudecodegui/session/CodexMessageHandler.java`
- `src/main/java/com/github/claudecodegui/session/SessionSendService.java`，创建并注入 session-owned tracker 与 session-owned tool registry。
- `src/main/java/com/github/claudecodegui/session/SessionState.java`，仅在需要提供批量追加 helper 或 pending scope 状态时修改。
- `src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java`，修正单文件/批量回滚成功语义，added file 删除必须 refresh VFS + filesystem fallback。
- `src/main/java/com/github/claudecodegui/util/ContentRebuildUtil.java`，返回结构化 rebuild 结果，不再 silent skip。
- `src/main/java/com/github/claudecodegui/handler/diff/EditableDiffHandler.java`、`src/main/java/com/github/claudecodegui/handler/diff/SimpleDiffDisplayHandler.java` 和 `src/main/java/com/github/claudecodegui/handler/diff/DiffFileOperations.java`，让 diff rebuild/reject/apply 写入失败可返回。
- `webview/src/components/StatusPanel/FileChangesList.tsx`、`webview/src/components/StatusPanel/StatusPanel.tsx`、`webview/src/hooks/useFileChanges.ts`、`webview/src/hooks/useFileChangesManagement.ts` 以及 bridge 类型，传递完整 operation、做防御性 dedupe、处理 partial result 与 Keep All pending-scope gate。

Node bridge 原则上不承载跨 provider 核心逻辑，但 Codex lifecycle 信号可靠性可能必须小幅修改：

- `ai-bridge/services/codex/codex-event-handler.js`
- `ai-bridge/services/codex/codex-tool-normalization.js`

如果确认 `wait_agent`/`close_agent` 的 `tool_use_id` 会被 signature 复用或 tool_result 去重吞掉，必须针对 lifecycle tools 保留 raw `payload.call_id` 或发出额外 sequence metadata；否则 Java 层不能安全 finalize Codex scope。

---

## 10. 安全规则

实现时必须满足：

1. 只处理 project base path 下的文件。
2. 忽略目录、`.git`、build 输出目录、二进制文件和超大文件。
3. 没有 before content 时，不生成可回滚 operation。
4. 文件在 scope start 前已经 dirty 且 VFS 没捕获 before snapshot 时，不生成 operation。
5. scope finalize 必须幂等，并按 `scopeId + completionToken` 去重。
6. 并行 sub-agent 存在多个 active scope 且 VFS 事件无法精确归属时，fail-closed，不生成可 rollback operation。
7. diff 打开前如果 `newString` 已经无法在当前文件中安全定位，应提示并保留在 `Edits`，不要展示错误 diff，也不要自动移除。
8. 回滚匹配不得 fallback 到第一个全局 `indexOf(newString)`；行范围附近没有唯一匹配时，如果全文件存在多处匹配，必须返回 `ambiguous_match`。
9. 显式 `safeToRollback=false` 的 operation，Java undo/reject 路径必须拒绝执行；前端应禁用 discard/reject 或把该 operation 从可回滚列表中排除。
10. 回滚失败时不能把文件从 `Edits` 中移除。
11. added file 回滚必须验证真实磁盘删除结果；VFS 未命中时要 refresh 并 fallback 到 filesystem delete，失败则返回失败。
12. `undo_all` partial success 必须返回逐文件结果；前端只能隐藏 succeeded files。
13. `Discard All` full success 也必须基于返回的 `succeededFiles` 或请求快照隐藏，不能清空当前最新列表。
14. `Keep All` 必须在 pending sub-agent flush 后才能执行；执行后仅移动 message boundary，不得用跨来源单一 edit sequence 阈值过滤未来 edits。
15. Codex `codex_session_patch` 与 VFS tracker 冲突时，以后端 source priority 决定唯一 operation。
16. 不安全或归属不明确的 operation 必须 skipped + diagnostic，不得显示为可回滚项。
17. Codex denied patch 如果 rollback 失败，必须把残留文件改动作为成功 tool_result 暴露给 Edits，但标记 `safe_to_rollback=false`，避免静默丢失真实磁盘改动。
18. 并行 sub-agent 的 VFS 事件缺少可靠 owner 信号时必须 fail-closed；多个 active scope 下不能猜 latest 归属，宁可跳过 ambiguous operation 也不能错归属。
19. `write/write_file` 只有在 `existed_before=false` 或无法证明已存在时才可按新增处理；`existed_before=true` 必须是修改。
17. `SimpleDiffDisplayHandler` 与 `EditableDiffHandler` 必须共享结构化 rebuild 失败语义；只修 editable path 不算完成。

---

## 11. 实现任务拆解

### Task 0：修正现有 Edits 操作语义

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java`
- Create/Modify: `src/main/java/com/github/claudecodegui/util/UndoOperationApplier.java`
- Modify: `src/main/java/com/github/claudecodegui/util/ContentRebuildUtil.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/diff/EditableDiffHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/diff/SimpleDiffDisplayHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/diff/DiffFileOperations.java`
- Modify: `webview/src/components/StatusPanel/FileChangesList.tsx`
- Modify: `webview/src/components/StatusPanel/StatusPanel.tsx`
- Modify: `webview/src/components/StatusPanel/fileChangeActions.ts`
- Modify: `webview/src/hooks/useFileChangesManagement.ts`
- Create/Modify: Java 与 webview 相关测试。

**Step 1：写失败测试**

覆盖：

- 单文件 undo 找不到 `newString` 时返回失败，前端不移除该 file change。
- 单文件 undo 遇到重复 `newString` 且 line range 不能唯一定位时返回 `ambiguous_match`，不能 fallback 到第一个全局匹配。
- 显式 `safeToRollback=false` 时 undo/reject 返回失败，前端保留该 file change。
- added file undo 在 VFS 未刷新时仍能通过 filesystem fallback 删除；如果磁盘文件仍存在则返回失败。
- `undo_all` 一部分文件成功、一部分文件失败时返回 `succeededFiles` 与 `failedFiles`，前端只隐藏成功项。
- `undo_all` 全成功时也返回 `succeededFiles`；前端按请求快照或返回列表隐藏，不能清空当前最新 Edits。
- `ContentRebuildUtil` 找不到 operation 时返回 skipped/failed 结构化结果，而不是 silent skip。
- `SimpleDiffDisplayHandler` 和 `EditableDiffHandler` 都消费结构化 rebuild result；失败时不展示错误 diff，也不移除 Edits。
- diff reject/apply 写入失败时不发送 remove-from-edits。
- bridge payload 保留 `lineStart`、`lineEnd`、`operationId`、`source`、`scopeId`、`safeToRollback`、`editSequence`。

**Step 2：实现后端结果协议**

建议协议：

```json
{
  "success": false,
  "partial": true,
  "succeededFiles": ["/path/A.java"],
  "failedFiles": [
    { "filePath": "/path/B.java", "reason": "new_string_not_found" }
  ]
}
```

单文件 undo 必须在 `newString` 无法定位、写入失败、文件不存在等情况下返回失败；批量 undo 不能把 partial success 包装成整体 success。

**Step 3：实现前端 partial handling**

- `StatusPanel` 对 `undo_all` partial success 只调用 per-file discard。
- 失败文件保留在 `Edits` 并显示错误 toast / message。
- `Keep All` 不复用 undo 的 operation-level processed key 语义；应移动 message boundary，并依赖 pending-scope gate 防止延迟 injection。
- `Discard All` 发起时保存 `requestId + filePaths + operationIds`，成功/partial 回调只处理该快照内且后端确认成功的文件。

**Step 4：运行测试**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.util.UndoOperationApplierTest --tests com.github.claudecodegui.handler.diff.EditableDiffHandlerTest --tests com.github.claudecodegui.session.SubagentEditScopeTrackerTest --tests com.github.claudecodegui.session.SubagentLifecycleDetectorTest
cd webview && npx vitest run src/components/StatusPanel/fileChangeActions.test.ts src/hooks/useFileChanges.test.ts src/hooks/useFileChangesManagement.test.ts
node --test ai-bridge/services/codex/codex-event-handler.lifecycle.test.mjs
```

Expected: PASS。

---

### Task 1：新增 EditOperationBuilder 测试和实现

**Files:**

- Create: `src/test/java/com/github/claudecodegui/util/EditOperationBuilderTest.java`
- Create: `src/main/java/com/github/claudecodegui/util/EditOperationBuilder.java`

**Step 1：写失败测试**

覆盖：

- 单行替换生成一个 edit operation。
- 多 hunk 修改生成多个 operations。
- 新文件生成一个 write operation。
- before/after 相同不生成 operation。
- 重复文本场景带上下文，降低误回滚风险。
- CRLF/LF 场景生成可用 operation。
- 二进制或超大文件跳过。

**Step 2：运行测试确认失败**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.util.EditOperationBuilderTest
```

Expected: FAIL，因为 `EditOperationBuilder` 尚未实现。

**Step 3：实现最小功能**

实现 line-based diff、hunk 合并、上下文生成、line range 记录。

**Step 4：运行测试确认通过**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.util.EditOperationBuilderTest
```

Expected: PASS。

---

### Task 2：新增 SyntheticFileChangeMessageFactory

**Files:**

- Create: `src/test/java/com/github/claudecodegui/session/SyntheticFileChangeMessageFactoryTest.java`
- Create: `src/main/java/com/github/claudecodegui/session/SyntheticFileChangeMessageFactory.java`

**Step 1：写失败测试**

断言：

- modified file 生成 `name=edit` 的 assistant `tool_use`。
- new file 生成 `name=write` 的 assistant `tool_use`。
- user `tool_result` 的 `tool_use_id` 正确匹配。
- `source=subagent`、`scope_id`、`agent_handle`、`parent_tool_use_id`、`operation_id` 被保留。
- raw message shape 能被前端 `normalizeBlocks` 识别。
- `ClaudeSession.Message.content` 为空，`raw.isMeta=true`，不会在聊天区显示 `Tool: edit`。
- 同一 scope 的多个 operations 被批量放入同一对 assistant/user meta messages。

**Step 2：实现 factory**

使用 `ClaudeSession.Message`、`JsonObject`、`JsonArray` 生成消息。tool id 使用 `scopeId + finalizeSequence + operationIndex` 生成全局唯一值。

**Step 3：运行测试**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.session.SyntheticFileChangeMessageFactoryTest
```

Expected: PASS。

---

### Task 3：新增 SubagentLifecycleDetector

**Files:**

- Create: `src/test/java/com/github/claudecodegui/session/SubagentLifecycleDetectorTest.java`
- Create: `src/main/java/com/github/claudecodegui/session/SubagentLifecycleDetector.java`

**Step 1：写失败测试**

覆盖：

- Claude `Task` tool_use 识别为 start。
- Claude `agent` tool_use 识别为 start。
- Claude matching tool_result 识别为 completion。
- Codex `spawn_agent` 识别为 start。
- Codex spawn result 从 JSON content 提取 `agentHandle`。
- Codex spawn result 从 text content / UUID / agent path 提取 `agentHandle`。
- Codex `wait_agent`/`close_agent` 识别为 completion signal。
- Codex lifecycle tool 使用 raw `call_id` / MCP `item.id` / sequence id 形成唯一 completion token，重复同 args 调用不会被合并。
- Codex 无法匹配 `agentHandle` 时 fail-closed，不 finalize oldest。
- Claude 同一 `tool_result` 通过双通道到达时只产生一个 completion event。
- Claude mixed user message 中已处理与未处理 `tool_result` 共存时，只对未处理 block 生成 completion event。

**Step 2：实现 detector**

输出 provider-neutral event：

```java
public final class SubagentLifecycleEvent {
    enum Kind { STARTED, SPAWN_RESOLVED, COMPLETED }
    Kind kind;
    String provider;
    String toolUseId;
    String parentToolUseId;
    String agentHandle;
    String completionToken;
}
```

**Step 3：运行测试**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.session.SubagentLifecycleDetectorTest
```

Expected: PASS。

---

### Task 4：实现 SubagentEditScopeTracker

**Files:**

- Create: `src/test/java/com/github/claudecodegui/session/SubagentEditScopeTrackerTest.java`
- Create: `src/test/java/com/github/claudecodegui/session/EditOperationRegistryTest.java`
- Create: `src/main/java/com/github/claudecodegui/session/SubagentEditScopeTracker.java`
- Create: `src/main/java/com/github/claudecodegui/session/EditOperationRegistry.java`
- Create: `src/main/java/com/github/claudecodegui/util/FileSnapshotUtil.java`

**Step 1：先写不依赖 VFS 的状态机测试**

覆盖：

- start scope 创建 active scope。
- before snapshot 每个文件只保存一次。
- finalize scope 生成 synthetic messages。
- finalize 幂等：相同 `scopeId + completionToken` 只输出一次 synthetic messages。
- 存在多个 active scopes 且 VFS 事件无法可靠归属时 fail-closed，不生成可 rollback operation。
- Codex `codex_session_patch` 已覆盖的文件不会再被 VFS tracker 生成重复 operation。
- 同路径不同 hunk 可以生成补充 operation，同路径同 hunk 必须被 registry 去重。
- registry source priority 固定且可测试，不能靠前端 dedupe 才避免重复展示。
- project base path 外文件被忽略。
- 缺少 before snapshot 的已有 dirty 文件被跳过。

**Step 2：实现核心 tracker**

建议接口：

```java
public final class SubagentEditScopeTracker {
    public void startScope(...);
    public void resolveAgentHandle(...);
    public List<ClaudeSession.Message> completeScope(String scopeId, String completionToken);
    public List<ClaudeSession.Message> completeEligibleScopes(...);
    public void recordBeforeSnapshot(String path, FileSnapshot snapshot);
    public void recordTouchedPath(String path);
}
```

**Step 3：接入 VFS listener**

- 第一个 scope 开启时 subscribe。
- 最后一个 scope 完成后 disconnect。
- finalize 前 refresh project root，并执行 size/mtime 稳定性探测。

**Step 4：运行测试**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.session.SubagentEditScopeTrackerTest --tests com.github.claudecodegui.session.EditOperationRegistryTest
```

Expected: PASS。

---

### Task 5：接入 ClaudeMessageHandler

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/session/ClaudeMessageHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionSendService.java`
- Modify/Test: `src/test/java/com/github/claudecodegui/session/ClaudeMessageHandlerRawConsistencyTest.java`
- Modify/Test: `src/test/java/com/github/claudecodegui/session/ClaudeMessageHandlerDedupTest.java`

**Step 1：新增测试场景**

模拟：

1. assistant `Task` tool_use 到达。
2. tracker 开启 scope。
3. 测试中注入一个 before/after 文件 delta。
4. matching tool_result 到达。
5. handler 在正常 tool_result 后追加 synthetic edit messages。
6. 同一个 tool_result 通过 `[MESSAGE]` 与 `[TOOL_RESULT]` 双路径到达时，handler 只追加一批 synthetic edit messages。
7. 同一 user raw message 同时包含已处理 tool_result 与新 tool_result 时，追加到 history 的 raw message 只保留新 block，已处理 block 不再暴露。

**Step 2：接入 start**

在 `handleAssistantMessage` 中，对 parsed raw assistant message 调用 `SubagentLifecycleDetector`。识别到 start 后，在通知前端前开启 scope。

**Step 3：接入 completion**

在 `handleUserMessage` 和 `handleToolResult` 两条路径中统一调用幂等 completion 入口；保留现有 tool_result message 行为，但 synthetic append 只能发生一次。

**Step 4：增加兜底**

在 stream end 或 onComplete 处只 finalize 明确已完成但尚未 flush 的 Claude scopes；仍不明确的 scope 保留 pending 或跳过可 rollback operation。

**Step 5：运行测试**

Run:

```bash
./gradlew test --tests com.github.claudecodegui.session.ClaudeMessageHandlerRawConsistencyTest --tests com.github.claudecodegui.session.ClaudeMessageHandlerDedupTest
```

Expected: PASS。

---

### Task 6：接入 CodexMessageHandler

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/session/CodexMessageHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/session/SessionSendService.java`
- Modify: `ai-bridge/services/codex/codex-event-handler.js`
- Modify: `ai-bridge/services/codex/codex-tool-normalization.js`
- Create: `src/test/java/com/github/claudecodegui/session/CodexMessageHandlerSubagentEditsTest.java`
- Create/Modify: `ai-bridge/services/codex/codex-event-handler.lifecycle.test.mjs`

**Step 1：新增测试场景**

模拟：

1. Codex assistant message 中出现 `spawn_agent` tool_use。
2. tracker 创建 provisional scope。
3. spawn tool_result 解析出 `agentHandle`。
4. `wait_agent` 或 `close_agent` 成功结果 finalize 对应 scope。
5. 无 `agentHandle` 或无法可靠匹配时 fail-closed，不 finalize oldest active scope。
6. turn completion 只 flush eligible scopes，不无条件 finalize remaining active scopes。
7. 重复 wait/close 或 tool id 复用场景不会重复/错误 finalize。
8. raw `payload.call_id`、MCP `item.id`、无 call_id sequence fallback 三条 Node bridge 路径都产生唯一 tool_use id。
9. lifecycle `tool_result` 缺失或失败时不 finalize，只记录 diagnostic。

**Step 2：修正 Node bridge lifecycle id**

先修 `ai-bridge`，保证 lifecycle tools 的 tool_use/tool_result id 具备每次调用唯一性，再接入 Java detector。否则 Java 侧无法区分重复 `wait_agent` 与同一调用的重复 result。

**Step 3：接入 lifecycle detector**

在 `handleAssistantMessage` 和 `handleUserMessage` parse 后调用 detector。

**Step 4：保留 Codex direct patch 路径**

不要移除 `ai-bridge/services/codex/codex-event-handler.js` 中现有 patch synthesis。重复问题必须由后端 source priority / operation registry 解决：`codex_session_patch` 覆盖的同一路径，VFS tracker 默认只记录诊断，不生成重复 operation。前端 dedupe 只是防御层。

**Step 5：运行测试**

Run:

```bash
node --test ai-bridge/services/codex/codex-event-handler.lifecycle.test.mjs
./gradlew test --tests com.github.claudecodegui.session.CodexMessageHandlerSubagentEditsTest
```

Expected: PASS。

---

### Task 7：前端保留 metadata 并去重

**Files:**

- Modify: `webview/src/types/fileChanges.ts`
- Modify: `webview/src/hooks/useFileChanges.ts`
- Create: `webview/src/hooks/useFileChanges.test.ts`

**Step 1：写测试**

构造 synthetic sub-agent `edit` 和 `write` messages，断言：

- modified file 显示为 `M`。
- new file 显示为 `A`。
- operation metadata 被保留，包括 `agentHandle`、`operationId`、`safeToRollback`、`editSequence`。
- 重复 operation 被折叠，dedupe key 不包含 `source/scopeId`。
- `codex_session_patch` 与 `subagent_vfs` 同 hunk 重复时前端只显示一个兜底项。
- failed tool_result 不会进入 `Edits`。
- hidden meta synthetic message 不显示为聊天文本，但能被 `useFileChanges` 解析。

**Step 2：实现 metadata extraction**

从 normalized input 读取 `source`、`scope_id`、`agent_handle`、`parent_tool_use_id`、`operation_id`、`safe_to_rollback`、`edit_sequence`。

**Step 3：实现 dedupe**

在 push 到 `fileOperationsMap` 前做 operation signature 去重；同时确保后续 diff/undo bridge payload 不丢 `lineStart/lineEnd/operationId/source/scopeId/safeToRollback/editSequence`。

**Step 4：运行测试**

Run:

```bash
cd webview && npx vitest run src/hooks/useFileChanges.test.ts && npx tsc -p tsconfig.test.json --noEmit
```

Expected: PASS。

---

### Task 8：可选来源标识

**Files:**

- Modify: `webview/src/components/StatusPanel/FileChangesList.tsx`
- Modify: `webview/src/components/StatusPanel/StatusPanel.less`
- Modify: `webview/src/i18n/locales/en.json`
- Modify: `webview/src/i18n/locales/zh.json`

**Step 1：确认是否需要**

如果要求“和主 agent 完全一样”，跳过本任务。

**Step 2：如需要，增加 badge**

当文件任一 operation 的 `source === 'subagent'` 时显示轻量 `Sub-agent` 标识。

**Step 3：运行测试**

Run:

```bash
cd webview && npm test
```

Expected: PASS。

---

### Task 9：增强定位安全性

**Files:**

- Modify: `src/main/java/com/github/claudecodegui/handler/file/UndoFileHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/util/UndoOperationApplier.java`
- Modify: `src/main/java/com/github/claudecodegui/util/ContentRebuildUtil.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/diff/SimpleDiffDisplayHandler.java`
- Modify: `src/main/java/com/github/claudecodegui/handler/diff/EditableDiffHandler.java`
- Modify: `webview/src/components/StatusPanel/FileChangesList.tsx`
- Modify: `webview/src/components/StatusPanel/StatusPanel.tsx`
- Create/Modify: `src/test/java/com/github/claudecodegui/util/UndoOperationApplierTest.java`
- Create/Modify: `src/test/java/com/github/claudecodegui/handler/diff/EditableDiffHandlerTest.java`
- Create/Modify: `webview/src/hooks/useFileChangesManagement.test.ts`
- Create/Modify: `ai-bridge/services/codex/codex-event-handler.lifecycle.test.mjs`

**Step 1：新增重复 newString 场景测试**

当前 rollback 使用第一次 `content.indexOf(newString)`，重复文本可能定位错误。用测试覆盖：

- 同一 `newString` 在文件中出现多次时，优先使用 `lineStart/lineEnd` 附近匹配。
- 行范围附近找不到时，如果全文件存在多处匹配，返回 `ambiguous_match` failure，不自动回滚。
- 行范围缺失时保持主 agent 既有单一匹配行为，但遇到多处匹配时返回 `ambiguous_match`，不能 fallback 到第一个全局匹配。
- `safeToRollback=false` 时 undo/reject 明确失败。
- added file 删除必须 refresh VFS；VFS 找不到时 fallback 到 `java.nio.file.Files.deleteIfExists`，并验证删除后文件不存在。
- `SimpleDiffDisplayHandler` rebuild 失败时返回/展示错误，不打开可能错误的 diff。

**Step 2：传递完整 operation**

确保前端 diff、单文件 undo、batch undo 都把 `lineStart`、`lineEnd`、`operationId`、`safeToRollback` 带到 Java；后端优先用这些字段缩小匹配范围并执行安全检查。

**Step 3：运行测试**

Run targeted Java 和 webview tests。

Expected: 主 agent 既有 rollback 行为不回归，sub-agent synthetic operations 具备 line-aware 安全定位。

---

### Task 10：手工集成验证清单

**Files:**

- Create: `docs/testing/subagent-edits-status-panel-checklist.md`

**Step 1：创建验证清单**

覆盖场景：

- Claude 主 agent edit 仍然进入 `Edits`。
- Claude `Task` sub-agent 修改一个文件，文件进入 `Edits`。
- Claude `Task` sub-agent 新建一个文件，文件显示为 added。
- Codex 主 agent patch 仍然只显示一次。
- Codex `spawn_agent` worker 修改一个文件，文件进入 `Edits`。
- Codex worker 新建一个文件，文件显示为 added。
- synthetic sub-agent 文件可以打开 diff。
- diff 中 Reject 写入成功后才移出 `Edits`；写入失败时保留。
- 单文件 rollback 能恢复文件并移出 `Edits`；找不到 `newString`、定位歧义或 `safeToRollback=false` 时失败且保留。
- 新增文件 rollback 在 VFS 未刷新时仍能删除真实磁盘文件；删除失败时保留 `Edits`。
- Discard All 能恢复所有 sub-agent 文件；partial failure 时只隐藏成功文件；full success 也只隐藏请求快照/后端返回的成功文件。
- Keep All 只隐藏执行时 message boundary 之前且已经 flush 的 files，不修改磁盘内容；pending sub-agent 未完成时按钮保持禁用。
- 并行 sub-agents 在缺少可靠 VFS owner 信号时 fail-closed，不产生错归属的危险 rollback operation。
- 并行 sub-agents 修改同一文件且无法归属时不生成危险 rollback。
- Claude 双通道 tool_result 不会产生重复 synthetic messages；mixed user message 只保留未处理 tool_result blocks。
- Codex 主 patch 与 VFS tracker 不会重复显示同一操作，后端 registry 记录 source priority 命中。
- Codex `wait_agent`/`close_agent` 重复、缺失、错误结果或无法匹配时 fail-closed。
- Codex Node bridge raw `call_id`、MCP `item.id`、无 call_id sequence fallback 都不会复用 lifecycle tool id。
- 已有 dirty 文件在缺少 before snapshot 时不会生成不安全 rollback。

**Step 2：运行完整验证命令**

Run:

```bash
node --test ai-bridge/config/api-config.test.js ai-bridge/services/claude/persistent-query-service.helpers.test.mjs ai-bridge/services/claude/persistent-query-service.test.mjs ai-bridge/services/codex/codex-event-handler.lifecycle.test.mjs
cd webview && npm test
./gradlew test
git diff --check
```

Expected: all pass。

---

## 12. 工作量评估

### MVP：可展示且操作语义可信

范围：

- Task 0 现有 undo / batch undo / diff reject 成功语义修正。
- Claude/Codex lifecycle detection 与 session-owned tracker。
- VFS-scoped before/after snapshot。
- Codex `codex_session_patch` 与 VFS tracker 后端单一权威来源策略。
- hidden meta synthetic edit/write messages。
- frontend metadata + 防御性 dedupe + partial undo result handling。
- Keep All pending-scope gate + message boundary acceptance。
- 不支持 agent 删除已有文件状态 `D`；但 added file rollback 必须支持真实删除新增文件。
- 不加来源 badge。

估算：**10-15 人日**。其中 2-3 人日用于先修 Edits 操作语义与 lifecycle id 安全底座，5-7 人日用于核心捕获/synthetic 链路，3-5 人日用于 Codex 双来源 registry、Keep All pending-scope gate 与测试补齐。

### 生产级增强

额外范围：

- dirty file reconciliation 兜底。
- 大文件/二进制跳过处理与性能压测。
- 更完整的 line-aware rollback / ambiguous match 处理。
- Codex real event fixture 覆盖 wait/close id 复用、tool_result 去重、worker patch 归属。
- Claude/Codex、streaming/non-streaming 手工验证。
- Subagents UI lifecycle 语义从 “spawn completed” 调整为 “worker completed”。

估算：**总计 15-22 人日**，包含 MVP。

### 完整增强版

额外范围：

- 新增删除文件状态 `D`。
- 删除文件 diff 展示。
- rollback 恢复删除文件。
- 并行 sub-agent 更精确归属。
- 如果 Codex SDK 暴露 child session path，则优先解析 child session patch。
- 更细的 conflict UI：展示 skipped/unsafe operations 的原因。

估算：**总计 3-4 周**。

---

## 13. 推荐发布节奏

建议拆成三个 PR 级别的阶段：

1. **Edits 操作语义加固**
   - 单文件 rollback 失败可见，ambiguous match fail-closed
   - added file delete refresh + filesystem fallback
   - `undo_all` partial/full success 都基于 `succeededFiles` 或请求快照
   - editable/simple diff rebuild 与 reject/apply 写入确认
   - 前端 partial handling、完整 operation payload、Discard All 快照

2. **核心捕获与 synthetic messages**
   - session-owned tracker / tool registry / operation registry
   - lifecycle detector 与 Claude mixed tool_result 过滤
   - Codex lifecycle raw id / MCP item id / sequence fallback
   - operation builder
   - hidden meta synthetic messages
   - Codex 后端单一权威来源策略
   - frontend metadata/dedupe 与 Keep All pending-scope gate

3. **可靠性与 UX polish**
   - dirty file reconciliation
   - 更完整的 line-aware diff/rollback 诊断
   - Subagents UI lifecycle 语义修正
   - 可选来源 badge
   - 手工验证清单

第一阶段不要做“被 agent 删除的文件”状态 `D` 支持。注意这不影响 added file rollback：新增文件的 discard 本质是删除该新增文件，必须在第一阶段保证真实磁盘删除成功语义。

---

## 14. 成功标准

实现完成后必须满足：

- Claude sub-agent 改动进入 `Edits`，行为与主 agent 改动一致。
- Codex sub-agent 改动进入 `Edits`，行为与主 agent 改动一致。
- Claude 主 agent 既有 edit/write 展示不回归。
- Codex 主 agent patch 展示不重复，`codex_session_patch` 与 VFS tracker 不产生双份 operation。
- sub-agent 文件能打开正确 before/after diff，且 hidden synthetic messages 不污染聊天内容。
- 单文件 rollback 找不到 `newString`、定位歧义、`safeToRollback=false` 或写入失败时返回失败并保留 `Edits`。
- added file rollback 必须真实删除磁盘文件；VFS 未刷新或删除失败时不能 silent success。
- Discard All partial failure 时只隐藏成功文件，失败文件仍可重试或查看原因；full success 也不能误隐藏请求后新注入的 synthetic Edits。
- Keep All 基于 pending-scope gate + message boundary，延迟 synthetic injection 不会让已接受项被错误处理。
- Claude 双通道 tool_result 只 finalize 一次；mixed raw message 不会重新暴露已处理 tool_result block。
- Codex `wait_agent`/`close_agent` 重复、缺失、tool id 复用或无法匹配时 fail-closed，不错误归属到最早 active scope。
- Codex Node bridge lifecycle id 在 raw `call_id`、MCP `item.id`、无 call_id fallback 场景下均保持每次调用唯一。
- 不安全 operation 被跳过并记录 diagnostic，而不是展示错误 diff 或执行危险 rollback。
- Java、Node 和 webview 测试覆盖 lifecycle、operation registry、operation builder、synthetic message、frontend parsing/dedupe、rollback result protocol、partial undo、Discard All 快照、Keep All pending-scope gate。
