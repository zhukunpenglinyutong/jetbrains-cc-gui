# 第一波大文件拆分实施计划

**日期**: 2026-03-17  
**状态**: 待执行  
**范围**: 第一波 8 个高收益拆分目标  
**目标**: 在不改变对外协议和用户行为的前提下，逐步拆分高复杂度核心文件，降低回归风险并为后续持续重构建立稳定边界。

---

## 本轮范围

本计划覆盖以下 8 个文件：

1. `src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java`
2. `src/main/java/com/github/claudecodegui/permission/PermissionService.java`
3. `src/main/java/com/github/claudecodegui/ClaudeSession.java`
4. `src/main/java/com/github/claudecodegui/skill/SlashCommandRegistry.java`
5. `ai-bridge/services/claude/persistent-query-service.js`
6. `src/main/java/com/github/claudecodegui/handler/DiffHandler.java`
7. `src/main/java/com/github/claudecodegui/provider/common/DaemonBridge.java`
8. `webview/src/components/ChatInputBox/ChatInputBox.tsx`

---

## 执行原则

- 每次只拆一个大文件，避免多点并发修改导致回归难以定位。
- 先抽离纯函数、常量、协议对象，再抽离 service / helper / coordinator，最后保留原入口类作为 facade。
- 除非该轮明确允许，否则不改消息协议、不改前端事件名、不改公共方法签名。
- 每次拆分结束后立即做最小验证，不把多个风险点堆到一次提交里。
- 单个阶段的目标是把文件结构变清晰，不追求一步彻底拆完。

---

## 统一验收要求

### Java / 插件端

- 编译与测试命令：`./gradlew test`
- 如有必要，增加定向验证：
  - `./gradlew test --tests ProviderManagerTest`
  - `./gradlew test --tests *Permission*`
  - `./gradlew test --tests *Diff*`

### Webview 前端

- 测试命令：`cd webview && npm test`
- 构建命令：`cd webview && npm run build`

### AI Bridge

- 现有 smoke 命令：
  - `cd ai-bridge && npm run test:claude`
  - `cd ai-bridge && npm run test:codex`
  - `cd ai-bridge && npm run test:sdk-status`
- 如拆分时抽出纯函数，优先补最小可运行测试。

---

## 推荐执行顺序

### Phase 1: 基础桥接与低耦合抽离

1. `ClaudeSDKBridge.java`
2. `DiffHandler.java`
3. `DaemonBridge.java`

### Phase 2: 核心会话与权限边界整理

4. `PermissionService.java`
5. `ClaudeSession.java`

### Phase 3: 发现与命令系统整理

6. `SlashCommandRegistry.java`
7. `persistent-query-service.js`

### Phase 4: 前端输入编排层瘦身

8. `ChatInputBox.tsx`

---

## 任务清单

## Task 1: 拆分 `ClaudeSDKBridge.java`

**当前问题**

- 同时承担 daemon 生命周期、prewarm/reset、请求参数构造、日志脱敏、流式输出适配、fallback 执行。
- 风险主要集中在并发、超时、daemon 可用性切换以及 Node 进程调用链。

**本轮目标**

- 保持 `ClaudeSDKBridge` 对外 API 不变。
- 将内部职责拆成明确协作对象，让主类只保留编排职责。

**建议拆分模块**

- `ClaudeLogSanitizer`
- `ClaudeRequestParamsBuilder`
- `ClaudeDaemonCoordinator`
- `ClaudeProcessInvoker`
- `ClaudeStreamAdapter`

**实施步骤**

1. 先提取日志脱敏逻辑和请求参数构造逻辑为纯 helper。
2. 提取 daemon 获取、prewarm、reset 为 `ClaudeDaemonCoordinator`。
3. 提取 per-process fallback 调用链为 `ClaudeProcessInvoker`。
4. 收拢流式回调与输出适配逻辑。
5. 让 `ClaudeSDKBridge` 只负责路由到 daemon 或 fallback，并组装结果。

**风险点**

- daemon 不可用时的 fallback 行为变化。
- 超时处理与原有日志行为变化。
- streaming 回调顺序变化。

**验收**

- Claude 请求、daemon prewarm、runtime reset、fallback 调用都可正常工作。
- `./gradlew test`

---

## Task 2: 拆分 `DiffHandler.java`

**当前问题**

- 单个 handler 处理 `refresh_file`、多种 diff 展示、interactive diff 等多个消息类型。
- 不同 diff 场景共享一个入口，导致后续扩展和回归排查都不方便。

**本轮目标**

- 将 diff 场景按消息类型拆开，保留统一入口。

**建议拆分模块**

- `DiffActionHandler`
- `RefreshFileHandler`
- `SimpleDiffDisplayHandler`
- `EditableDiffHandler`
- `InteractiveDiffMessageHandler`
- `DiffRequestDispatcher`

**实施步骤**

1. 引入 `DiffActionHandler` 接口定义统一处理入口。
2. 把 `refresh_file` 单独提取。
3. 按普通 diff、editable diff、interactive diff 分别下沉实现。
4. 在 `DiffHandler` 中保留 `SUPPORTED_TYPES` 和分发逻辑。

**风险点**

- 原有 UI 线程调度时机变化。
- 文件刷新与 diff 展示调用顺序变化。

**验收**

- 普通 diff、可编辑 diff、interactive diff、refresh file 均能正常触发。
- `./gradlew test`

---

## Task 3: 拆分 `DaemonBridge.java`

**当前问题**

- 同时负责进程启动、ready 等待、stdin/stdout 协议、pending request、heartbeat 与重启策略。
- 协议逻辑与生命周期逻辑耦合较深，修改风险高。

**本轮目标**

- 将 daemon 管理拆为“启动器 + 协议客户端 + 健康监测”三部分。

**建议拆分模块**

- `DaemonProcessLauncher`
- `DaemonProtocolClient`
- `PendingRequestRegistry`
- `DaemonHeartbeatMonitor`

**实施步骤**

1. 提取请求 ID、pending request、完成回调管理逻辑。
2. 提取协议读写与 NDJSON 响应路由。
3. 提取 heartbeat 检查和 restart window 策略。
4. 最后提取 daemon 启动与 ready 等待流程。

**风险点**

- daemon ready 竞态。
- 心跳线程和 reader thread 生命周期管理。
- request 失败时是否还能正确 fail fast。

**验收**

- daemon 启动、ready 检测、sendCommand、心跳、停止流程正常。
- `./gradlew test`

---

## Task 4: 拆分 `PermissionService.java`

**当前问题**

- 混合了权限文件协议、watch service、session registry、dialog 路由、decision memory、空闲清理等职责。
- 涉及文件系统、并发、多项目窗口协调，属于高风险核心类。

**本轮目标**

- 保持权限链路行为不变，但按职责拆成多个稳定模块。

**建议拆分模块**

- `PermissionFileProtocol`
- `PermissionRequestWatcher`
- `PermissionSessionRegistry`
- `PermissionDecisionStore`
- `PermissionDialogRouter`

**实施步骤**

1. 先抽离 request/response 文件命名、读写、轮询辅助逻辑。
2. 再抽离 permission memory 和 tool-level decision memory。
3. 提取 dialog shower 注册与路由逻辑。
4. 最后整理 watch service 与 cleanup 逻辑。

**风险点**

- WatchService 与文件写入竞态。
- ask-user-question / plan-approval 回写格式兼容性。
- 多 project dialog 路由行为变化。

**验收**

- 权限确认、always allow、deny、ask-user-question、plan-approval 全流程正常。
- `./gradlew test`

---

## Task 5: 拆分 `ClaudeSession.java`

**当前问题**

- 集中了会话状态、消息生命周期、上下文注入、bridge 调用、permission 转发、callback 通知。
- 该类是多个核心链路的汇合点，继续增长会明显抬高维护成本。

**本轮目标**

- 将 `ClaudeSession` 收敛为会话聚合入口，把复杂流程下沉为内部协作者。

**建议拆分模块**

- `SessionContextService`
- `SessionSendService`
- `SessionMessageOrchestrator`
- `SessionCallbackFacade`
- `SessionProviderRouter`

**实施步骤**

1. 先抽上下文注入和上下文收集相关逻辑。
2. 提取发送链路，把 Claude / Codex 分支与 bridge 调用剥离。
3. 提取消息解析、消息合并、stream 更新编排。
4. 保留 `ClaudeSession` 作为状态和公共 API 入口。

**风险点**

- streaming 消息和 usage 更新顺序。
- 恢复会话与新建会话行为差异。
- permission request 转发与回调通知时机。

**验收**

- 发送消息、停止消息、恢复会话、summary 更新、usage 更新、permission request 正常。
- `./gradlew test`

---

## Task 6: 拆分 `SlashCommandRegistry.java`

**当前问题**

- 同时处理 built-in、managed skills、plugins、prompts、额外目录、manifest 解析、路径安全策略。
- 职责天然可分，但当前都聚合在一个巨型 registry 中。

**本轮目标**

- 按“命令来源”和“安全策略”拆分，而不是按零散 helper 拆分。

**建议拆分模块**

- `ManagedSkillScanner`
- `PluginCommandScanner`
- `PromptCommandScanner`
- `AdditionalDirectoryResolver`
- `SlashCommandPathPolicy`
- `SlashCommandJsonReader`

**实施步骤**

1. 先抽路径归一化、安全校验、manifest 读取等底层能力。
2. 再按 managed / plugin / prompt / additional dirs 拆扫描器。
3. 最后由 `SlashCommandRegistry` 聚合结果并保持外部入口不变。

**风险点**

- path normalization 行为变化。
- 插件命令发现顺序变化。
- 路径安全收紧或放松导致结果不一致。

**验收**

- built-in、managed skills、plugin commands、prompt commands 数量和来源保持稳定。
- `./gradlew test`

---

## Task 7: 拆分 `persistent-query-service.js`

**当前问题**

- Node 侧单文件承担 runtime registry、permission mode、stream event 处理、tool result 裁剪、cleanup 调度和对外入口。
- 逻辑密度高，后续修改时容易影响整条会话链路。

**本轮目标**

- 将运行时状态管理和消息处理拆成独立模块，主文件只保留公开 API。

**建议拆分模块**

- `permission-mode.js`
- `runtime-registry.js`
- `runtime-lifecycle.js`
- `stream-event-processor.js`
- `message-output-filter.js`

**实施步骤**

1. 先抽纯函数：truncate、normalizePermissionMode、buildRuntimeSignature。
2. 再抽 runtime registry 与 cleanup 定时逻辑。
3. 抽 stream event / message content / tool result 处理。
4. 最后让主文件只保留公开入口和高层编排。

**风险点**

- runtime 归属判断与 cleanup 时机变化。
- streaming 输出内容顺序变化。
- plan / acceptEdits 权限模式下的 auto-approve 行为变化。

**验收**

- `sendMessagePersistent`、`sendMessageWithAttachmentsPersistent`、`preconnectPersistent`、`resetRuntimePersistent`、`abortCurrentTurn` 行为不变。
- `cd ai-bridge && npm run test:claude`
- `cd ai-bridge && npm run test:codex`
- `cd ai-bridge && npm run test:sdk-status`

---

## Task 8: 拆分 `ChatInputBox.tsx`

**当前问题**

- 虽然已有较多 hooks，但主组件仍然承担太多 completion、attachment、selection、banner、imperative handle 和输入编排逻辑。
- 可读性和审查体验仍然偏差。

**本轮目标**

- 不强行打散成熟 hooks，而是继续降低主组件的编排密度。

**建议拆分模块**

- `useOpenSourceBannerState`
- `useChatInputCompletionsCoordinator`
- `useChatInputAttachmentsCoordinator`
- `useChatInputSelectionController`

**实施步骤**

1. 先抽 banner 和 localStorage 状态。
2. 再抽 file / slash / agent / prompt / dollar command completion 的统一协调逻辑。
3. 把 attachments 和 imperative handle 相关逻辑整理为更清晰的协作层。
4. 保留主组件作为 UI 装配层。

**风险点**

- completion 关闭顺序变化。
- 输入法、键盘导航、selection 恢复细节回归。
- attachment 恢复与草稿行为变化。

**验收**

- 输入、发送、停止、completion、attachment、IME、history completion 行为不变。
- `cd webview && npm test`
- `cd webview && npm run build`

---

## 每次提交建议模板

每个文件建议至少拆成 2 到 4 个小提交：

1. `refactor: extract pure helpers from <file>`
2. `refactor: extract coordinator/service from <file>`
3. `refactor: slim <file> facade`
4. `test: cover extracted behavior from <file>`（如适用）

---

## 完成标准

- 8 个文件均建立清晰职责边界。
- 原始入口类或组件仍可作为兼容 facade 使用。
- 每一轮拆分均通过对应最小验证。
- 文档、命名和目录结构能让后续继续拆分，而不是重新长回去。

---

## 开始执行建议

建议按以下顺序直接开始：

1. 先拆 `ClaudeSDKBridge.java`，验证桥接拆分方法是否顺手。
2. 再拆 `DiffHandler.java`，快速建立 Java 侧 dispatcher 模式。
3. 接着处理 `DaemonBridge.java`，把 daemon 协议边界稳定下来。
4. 然后进入 `PermissionService.java` 和 `ClaudeSession.java` 这两个核心大类。
5. 再整理 `SlashCommandRegistry.java` 与 `persistent-query-service.js`。
6. 最后处理 `ChatInputBox.tsx`，收口前端主输入组件。
