# Codex app-server 运行时合同

本文档是 Codex 常驻 app-server 运行时的协议与行为合同，由 `migrate-codex-to-app-server` 变更产出并随实现维护。变更过程、设计决策与各轮审查/验收记录见 `openspec/changes/migrate-codex-to-app-server/`；需求→验证追踪表见同目录 `verification-tracking.md`，实施基线见同目录 `implementation-baseline.md`。

2026-10-05 的第十一轮审查（D34/任务39）修复启动失败后等待未结束、连续无 stream-start 的失败丢失终态、并发 reset 覆盖新运行时，以及延后 Diff 决定的路径与会话归属。启动八秒只保护早到 cleanup，提交身份保留至明确开始或终态；完整与尾部 ERROR 使用本次捕获的 clientMessageId 收尾，旧请求错误不解除新发送。新的 busy/loading 边界重新准备一次终态；reset 调用共享一次真实 child 退役。

原生 Diff 打开前冻结绝对 target、rename source、sessionId/provider/ledgerKeys；接受与拒绝的成功回执只更新原会话已审阅检查点，保留后来编辑，明确 null 不借用当前会话。失败不记账，既有文件校验保持。离线历史只增加实际原生退出诊断的匹配；助手复制保留完整格式示例，用户附件包装仍会清理。审查范围、旧页面红绿、真实 stdio 与只读现场证据的区别，以及最终来源与交付见 `review-round-11-results.md`。

提示词增强与提交信息生成也使用 Codex CLI 的 app-server。每次创建独立 ephemeral thread，沿用已启用提供商或已授权 CLI Login 的原生配置；使用只读沙箱、never/user 策略，后台交互明确拒绝或取消。只有 completed 返回成功，最终答案覆盖预览；超时/失败也会关闭并等待 child 退出。此路径不加载 Codex SDK，不恢复聊天会话。

- 背景：将 Codex 从「每轮 `codex exec` + JSONL 补读 + 执行后确认/回滚」迁移到常驻 `codex app-server --listen stdio://`（Java → Node daemon → app-server stdio JSON-RPC）。
- 协议边界：官方 app-server v2 信封 `{id, method, params}` / `{id, result|error}` / `{method, params}`（无 `jsonrpc` 字段）；`thread/start.sandbox` 为 kebab-case 字符串，`turn/start.sandboxPolicy.type` 为 camelCase，collaboration settings 使用 snake_case。

## Daemon 命令与事件合同

`persistent-codex-service.js` 面向 daemon 暴露以下命令。**长操作**走 daemon commandQueue（占用 activeRequestId 直至原生终态）；**控制操作**绕过 commandQueue（绝不触碰 activeRequestId，立即回执），否则批准回复会被排在自己等待的 send 之后造成死锁。

| 命令 | 类型 | 作用 |
|---|---|---|
| `codex.send` | 长操作 | 登记 send operation（FIFO），携带 clientMessageId/冻结设置，等待原生终态 |
| `codex.compact` / `codex.review` | 长操作 | 同一 FIFO；先过 settings revision 门 |
| `codex.preconnect` | 长操作（短） | 启动/复用运行时并 resume thread，不发起回合 |
| `codex.updateSettings` | 控制 | 记录 desired 设置（effectiveness 由通知确认） |
| `codex.respondInteraction` / `codex.respondInteractionError` | 控制（绕过队列） | 对指定 rpcId 回 typed result/error |
| `codex.abortTurn` | 控制（绕过队列） | 停止活动 operation（派发阶段语义见下文） |
| `codex.releaseThread` / `codex.resetRuntime` | 生命周期 | 排空 relation set / 关闭 child 并确认退出 |
| `codex.listThreads` / `codex.readThread` / `codex.readHistoryPage` / `codex.readSubagent` | 独立只读通道 | 通过 app-server history projection 查询；child 先验证 parentThreadId 关系，不占发送 FIFO、不 resume writer |
| `codex.listModels` / `codex.listSkills` / `codex.getMcpStatus` / `codex.reloadMcp` | 独立只读通道 | 目录与 MCP 状态查询；reload 仍受 native runtime access 门控 |

事件（进程级 NDJSON，经 `_originalStdoutWrite` 直写，**不带** activeRequestId 包装）：

```json
{"type":"daemon","event":"codex_event","provider":"codex","runtimeGeneration":3,"channelId":"channel-id","sessionEpoch":"7","clientOperationId":"op-3-...","rootThreadId":"th-root","threadId":"th-child","turnId":"turn-1","itemId":"item-1","kind":"turnStarted","payload":{}}
```

- `kind` 枚举：runtimeStateChanged / threadStarted / threadResumed / operationQueued / operationAcked / turnStarted / turnAborted / itemStarted / itemCompleted / itemUpdated / interactionRequested / operationDone / orphanTurnTerminal / runtimeUnhealthy / runtimeReset / thread/settings/updated 等（未知原生通知以 `nativeNotification` 透传摘要）。
- `threadRelationVerified` 只在当前 native client 验证 parent/root 后发出，Java 据此登记子线程的 writer；只读子历史查询不领取 writer。旧 client 查询结束后不发布到新代，释放根会等待 native child 退出再释放关系租约。
- marker（`[MESSAGE_START]` / `[MESSAGE_END]` 等）走 console.log，被 daemon 包装进**当前请求**的 envelope——这是有意的 per-operation 捕获 emitter；后台 thread 事件永远不走该通道。
- heartbeat/status 的 `runtimes.codex` 快照与 idle reaper：`getCodexRuntimeSnapshot()`；`sessionCount>0 || busy` 时 daemon 不 retire。

示例 NDJSON 可由 Node fixture（`persistent-codex-service.test.js`）与 Java fixture 共同解析。

## 持久 service 运行时状态与恢复

`CodexAppServerService`（`ai-bridge/services/codex/codex-appserver-service.js`）是每个聊天宿主一实例的常驻编排层。状态与恢复语义：

### 运行时状态机

```text
STOPPED → STARTING → INITIALIZING → READY → DRAINING → STOPPED
任意活动态 → FAILED（协议/进程故障；下一次用户操作可重新启动）
```

- `READY` 时才派发 FIFO 操作；`#drainQueue` 在非 READY 时先 `ensureRuntime` 再继续。
- 连接意外退出（EOF/崩溃）→ `#failRuntime` 一次性收尾：所有未结算 operation 标记 failed、队列清空、thread 状态回到 `unloaded`（**thread id 保留**）、child 关闭。恢复 = 重新 initialize + `thread/resume`，绝不自动重发 `turn/start`。

### 操作与派发阶段

每个 operation 依次经过 `notWritten → writtenUnconfirmed → nativeTurnKnown → terminal`：

- 注册先于写入；`turn/started` 通知（先于或后于 ack）将 operation 绑定到 native turnId，同一 operation 不绑定两个回合。
- 终态只认 `turn/completed` 的 `completed/failed/interrupted` 与已确认的 child 退出；ack、本地超时、单个 item、重试中的 error 都不是终态。
- Stop（10 秒总确认预算，从 cancelRequested 起算，迟到 ack 不重置）：
  - 仍在队列（未派发）→ 本地取消，零 RPC；
  - 活动但未写入且自身 bootstrap 未确认 → 保留取消意图，dispatch 门在 bootstrap 确认后生效；
  - `nativeTurnKnown` → 立即 `turn/interrupt`，等待原生终态；
  - 已写入但身份未知 → 保留取消意图，身份到达即 interrupt；预算内仍无法确认 → 关闭 child、确认退出后一次性失败收尾（`runtimeUnhealthy` 事件）。

### 设置 revision 门

- `updateSettings` 只更新 desired（revision 递增）；effectiveness 以 `thread/settings/updated` 通知为准（official source common.rs:685/1941，experimental）。
- 每次 FIFO 派发前冻结最新 desired revision：`send` 内联携带设置；`compact/review` 无设置参数 → 先 `thread/settings/update` 并等待匹配的 effective 通知，未确认不启动。
- 断线/child 退出后只恢复 thread；冷 resume（rebuild）应用新的 developerInstructions 并由上层清除临时 acceptForSession/session grants。

### Launch-config 重建

- `computeCodexRuntimeFingerprint` 覆盖 authMode/凭证哈希/endpoint/provider/headers/CODEX_HOME/CLI 来源；model/effort 等普通设置不参与（走 RPC）。
- fingerprint 变化 → `notifyLaunchConfigChange`：空闲边界立即重建；活动回合中推迟到终态后。重建 = 排空 + resetRuntime + ensureRuntime + 冷 resume 根 thread（`threadResumed` 事件供上层清理临时授权）。

### 测试映射

`codex-appserver-service.test.js` 覆盖：多轮复用同一连接、通知先于 ack 绑定、FIFO 顺序、重复终态只收尾一次、断线恢复不重发、三种 Stop 路径 + bootstrap 停止、settings 门、fingerprint 重建（空闲/活动推迟）、child 终态不释放父 FIFO。fixture 由 `testing/codex-stdio-peer.js` 提供（`silent-start`/`never-respond`/`reverse-approval` 等场景）。

## 协议信封、ID 与超时基准

`CodexAppServerClient`（`ai-bridge/services/codex/codex-appserver-client.js`）按结构分流，以下示例全部可通过 `ai-bridge/services/codex/testing/codex-stdio-peer.js` 的对应场景解析：

| 方向 | 形态 | 示例 |
|---|---|---|
| 客户端请求 | `{id, method, params}`（无 `jsonrpc` 字段） | `{"id":1,"method":"turn/start","params":{"threadId":"th","input":[{"type":"text","text":"hi"}]}}` |
| 客户端请求响应 | `{id, result}` 或 `{id, error}` | `{"id":1,"result":{"thread":{…}}}` |
| 通知 | `{method, params}`（无 id） | `{"method":"turn/started","params":{"threadId":"th","turn":{"id":"t","status":"inProgress"}}}` |
| 服务端请求 | `{id, method, params}`（id 可为 number 或 string） | `{"id":3,"method":"item/commandExecution/requestApproval","params":{…}}` / `{"id":"server-fixture-77","method":…}` |
| 服务端请求回复 | 原样回传 id 的 `{id, result}` / `{id, error}` | `{"id":3,"result":{"decision":"accept"}}`、拒绝：`{"id":9,"error":{"code":-32601,"message":"unsupported server request: …"}}` |

规则：

- **ID 类型保留**：number/string 原样回传；双向各自维护 pending registry，同一数值 ID 在两个方向互不覆盖（fixture `numeric-id-collision`）。
- **握手单飞**：spawn → `initialize`（clientInfo `codemoss_intellij` + `capabilities.experimentalApi: true`）→ 响应 → `initialized` 通知 → READY；并发业务调用共享同一握手 promise，握手失败时没有任何业务 RPC 上线（fixture `initialize-refusal`）。
- **短 RPC 预算**：默认 30 秒；用户交互（批准/询问）绝不借用短 RPC 超时。超时只是客户端等待失败（`err.code='RPC_TIMEOUT'`，`err.phase` 为 `notWritten` 或 `writtenUnconfirmed`），不代表原生操作终结；迟到的响应通过 `lateResponse` 事件保留给上层做 dispatchPhase 关联（fixture `never-respond`）。
- **非法 JSON 行**不中断运行时（`protocolError` 事件）；EOF/进程退出以 `CHILD_EXITED` 一次性收尾，pending、timer、reader 全部清理，之后请求以真实退出错误失败。
- **未知服务端请求**显式回 `-32601`（不自动批准、不降级 exec）；未知通知向上层透传，不影响活动回合（fixture `unknown-server-request`）。

## 运行方式与 CLI 识别

Codex 与 OpenCode 共用「提供商管理 → CLI」的识别列表，展示本机 CLI 的路径、版本和手动安装指引。SDK 页面及 SDK 安装、版本、更新、卸载 API 不再管理 Codex，聊天也不再依赖 `codex-sdk` 安装状态。可手动安装官方 CLI（`npm install -g @openai/codex`），再刷新 CLI 页面。

显式路径或 `CODEX_BIN` / `CODEX_PATH` / `CODEX_CLI_PATH` 优先，其次查找 PATH、常用安装位置和登录 shell。失效的显式覆盖会报错。只有没有外部 CLI 时才兼容查找旧 `~/.codemoss/dependencies/codex-sdk/` 中的既有 CLI binary/launcher；不创建安装标记、不修改或删除该目录。只有 SDK metadata 的旧目录不算 CLI 可用。Windows npm `.cmd` 使用现有 CLI spawn adapter 启动；不扫描 Codex 桌面应用 bundle。

**多候选与启动回退**：同一台机器常同时存在多份 codex（版本管理器、npm 全局前缀、手动下载）。发现阶段不再只取第一个命中项，而是按「显式/env 覆盖 → PATH 全部命中 → home 候选目录 → 常用 bin 目录 → 登录 shell」列出全部候选，并按真实路径去重（符号链接归一）。每个候选只做文件系统判定，不 spawn 任何进程（CLI 页面仍然独占版本探测）：`bin/codex.js` npm 启动器会在其所在 `@openai/codex` 包（含嵌套与提升布局）内查找平台二进制；缺失时该安装被判定为「未确认」，降到最后一位作为保底，既不抢占后面可确认可用的安装，也不会因为启发式漏判而彻底拿掉用户本来可用的 CLI。完全不能作为 CLI 的路径（不存在、非文件）直接丢弃并给出原因。

解析结果同时返回 `candidates`（按优先级的可用候选，末尾为未确认保底项）与 `rejected`（完全不可用项及原因）。运行时的 `startupAttempts` 等于候选数：某个候选在 READY 之前退出（启动器 ENOENT、初始化失败、握手超时）时，服务在**未派发任何 RPC** 的前提下关闭该 generation、切到下一个候选重试，并发出 `runtimeFallback` 事件；只有全部候选失败才按失败收尾。READY 之后的退出绝不重试（不重放未知工作）。

**失败诊断**：客户端保留最近若干行已脱敏 stderr，并在 READY 之前退出时把「启动失败标记 + 启动命令 + stderr 尾部」挂在 `err.details` 上（`err.message` 仍是规范文本 `codex app-server exited (code=…, signal=…)`，历史回退等既有匹配者不受影响）。runtime 失败文案在保留该规范前缀之外，追加每个候选 CLI 的尝试结果与一句可操作提示，前端按 `codexCliUnavailable` 诊断模式给出重装/改 `CODEX_BIN` 的步骤；`CodexNativeHistoryReader.permitsOfflineFallback` 对退出行采用前缀容忍匹配，带诊断后缀时仍允许只读历史回退。

CLI 页面仅运行版本探测，不读取 config/auth、不启动 app-server；原生聊天与目录访问仍遵守运行方式授权。Node system-status 保留 `codex` 消费合同并报告实际 CLI 命令路径；它不是 SDK 管理入口。

运行方式（`getCodexRuntimeState()`）与 app-server child 的关系：

| access | 行为 |
|---|---|
| `managed` | 使用已识别 CLI + 插件配置的 provider/endpoint/凭证（env_key 传递），可启动 app-server child |
| `cli_login` | 使用已授权用户原生认证（CODEX_HOME），创建 child 前只补原生 provider env_key 指定且未继承的登录 shell 变量；已有值和明确空值保留 |
| `inactive` | **不启动 app-server child**：聊天、模型/skills/MCP 目录探测、历史读取都不得为解析或探测而 spawn 进程；已有本地 JSONL 历史只读能力继续可用 |

native auto 能力不再以 TypeScript SDK 版本判断：模式选择由原生运行时在发送时校验（原生 constraints 拒绝时显示错误，不回退 exec）。前端已移除 `codexSdkMeetsMinimum` 门控（`useModelProviderState` / `modelProviderStateHelpers`），Codex plan 通过原生 `collaborationMode` 发送并保持独立的 native approval/sandbox 设置。

GUI 的 env_key 查找使用实际 CODEX_HOME/config.toml，只读 TOML provider 字符串字段，支持普通/inline/dotted/quoted 配置并忽略指令正文。managed/inactive 不使用此发现路径；合法名字才可传入既有允许的登录 shell，不复制整份 shell 环境，不打印值或 shell stderr，解析/查找失败仍由原生鉴权报告。Windows 保留显式变量及大小写别名，不主动探测 POSIX shell。异步 child 准备仍受 generation/release 门控，旧查找结果不能启动已释放的 writer。

## 历史显示与目录来源

授权运行时优先通过 `thread/read` 元信息、`thread/turns/list` 和 `thread/items/list` 读取显示记录，保存 opaque cursor，并以 thread/turn/item/clientId 对账重叠页和本地未确认提交。仅原生明确不支持分页时固定选择 includeTurns 整读；读取过程不 resume、不抢执行 owner。鉴权、writer 或策略错误不触发离线 fallback。

在 inactive、CLI/传输不可用，或原生投影遗漏工具、明文思考及 compact 前记录时，选择整个 legacy 只读 transcript；一次加载不会拼接两个来源。旧分页/整读共用 wrapper 回放器，静态 shell_command/exec_command 可显示 Bash 卡片，未知或混合 wrapper 保留通用卡片和输出。明文 reasoning summary/content 显示为可展开思考；仅加密记录也保留已知思考边界和状态，展开显示无可读内容提示，不显示密文。内部 `external_codex_apps_open_page` 标签被去除，实际用户文字与图片保留。这些显示记录不会回注模型。

原生子代理卡片使用实际 child thread ID；历史/status 先验证 parentThreadId 祖先链，active 子线程不因父终态或旧的 completed turn 被显示为完成。跨 Tab 的显示查询只读；切换根会话后旧请求不能更新新页面。节点状态未知时继续查询，不猜测完成。

模型目录使用原生 model slug、隐藏项和 reasoning effort 元数据。skills 目录按 cwd 读取原生 name/path，支持同名不同路径，刷新或配置变化会清除失效选择；选择项以原生 skill 输入发送。MCP 连接/认证状态来自原生目录，配置 CRUD 保留已有授权边界，用户刷新或写入成功后触发原生 reload。各目录按请求 ID 接受结果，skills 页面不同时加载模型/MCP；错误会在相应页面显示。

## 编辑、命令、图片和 compact 的显示

- `apply_patch`（直接或旧 exec 的静态实参）与 `fileChange` 共用 Claude 的编辑标题、操作栏、diff 和默认展开设置，展示全部文件、增删行和真实状态，变化类型及移动路径保留在悬停说明。真实错误为红色状态，详情收进展开区域。混合/部分动态 wrapper 中可确认的 literal 补丁也可预览；缺少单独结果时为灰色 unknown，完整 wrapper 与输出保留。历史只用于显示，不执行补丁；hunk 只在聊天中预览，不冒充完整 old/new 文件内容。
- `commandExecution` 的原生类型不保证提供“执行原因/summary”；已有 description/summary/title 被保留，原生批准 `reason` 与旧 `justification` 单列为批准理由。`commandActions` 的读取、列目录和搜索可形成动作摘要；不能把前一段思考或命令名编造成执行动机。
- `dynamicToolCall` 使用原生 namespace/tool/arguments，文本和图片结果保留为标准结果块数组。inProgress 不显示已完成，终态和 success=false 按实际状态显示。通用卡片展开可查看已有结果正文/图片，混合 wrapper 的实际错误输出也可查看。
- MCP 的 content 保持块数组，原生 image/data/mimeType 映射为共用图片 source，structuredContent 单独保留为可读块；实时与旧历史回执共用显示约定。网页 item/started 即可显示，在所属 operation 中断或失败后补配对终态，避免持续 pending。
- 桌面端完整附件包装在显示/复制时剥离，保留真实任务及普通文件引用。图片以正文气泡外的缩略图组显示，Codex 气泡复用 Claude 的主题色；仅图片不渲染空气泡，预览支持键盘关闭并恢复焦点。
- `contextCompaction` 和旧 `compacted` 即使没有摘要也在原消息位置显示压缩边界，禁止合入普通 assistant 或过滤空正文。优先显示原生 item 时间，只有 turn 时间则注明近似来源；实时收到事件的时间标明“记录时间”，历史缺失则未知。原生历史不能保证恢复手动/自动触发来源，缺字段不猜测。
- `SessionIndexManager` 当前缓存版本为 v10，重建旧附件清单标题及内部自动审批过滤；临时分页 spool 随 reader 重建。

## 原生交互、秘密答案和工作区 diff

Java 为每个原生反向请求生成由 channel、session epoch、runtime generation 和原始 RPC ID 组成的不透明 `interactionKey`，并为当前页面签发 `dialogToken`。页面只回传这两个 opaque 值；Java 从 registry 取回真实 RPC ID、thread/turn/item 身份后发送 typed result，重复、过期或旧页面回答会被拒绝。JCEF 重建时 registry 保留 deadline 与 params 快照，`frontend_ready` 后按 `deliverySequence` 重放尚未 resolved 的请求并轮换 `dialogToken`；原生 `serverRequest/resolved` 事件携带相同 token，页面只关闭对应弹窗。

每次用户提交由 webview 生成 `clientMessageId`，乐观气泡、Java `SessionState`、Node `codex.send` 与原生 `turn/start.clientUserMessageId` 共用该值。原生 `userMessage.clientId` 到达后按身份更新原气泡，重复文本不会被当成同一条提交；不确定失败不会自动重发。

Codex 的 `requestUserInput` 和 MCP elicitation 在提交前写入插件私有 `~/.codemoss/codex-privacy/` 版本化索引。每次写入独立 `<home 指纹>.record.<uuid>.json` 原子记录，Node/Java 兼容读取旧 `<home 指纹>.json`，避免多个窗口的独立 Node 进程互相覆盖分类。索引只包含宿主/home scope、thread、turn、call、item、question 身份和 secret 标记，不写问题正文、答案或答案 hash；原生仍可能把已提交答案保存到自己的 transcript，插件不宣称可以控制该存储。页面草稿会跳过 `isSecret` 问题，索引原子写入失败时不会转发交互。

损坏 JSON/版本/条目与持久 conservativeMasking 继续保护答案及不可确认的工具结果；后续新记录不会覆盖丢失分类，冷读也不释放旧 opaque 结果或普通 answers。正常用户文字、思考、模型 JSON 回复、命令参数与历史时间/状态字段保持原值，不因索引损坏遮蔽整段会话。仅在结果体内解析答案 JSON；结果数据不能因字段名为 id/name/path/status 而被豁免，外层协议身份及已知内容类型保留。question 名称只在匹配交互内保护答案/值，题目正文和其他调用的同名数据保持可见。MCP elicitation 的 RPC ID 不当作工具 call/item ID，无 item 时按 turn 保护输出；turnId 为 null 时按 thread 保护输出，具体 call 的可靠普通分类仍优先。

MCP form elicitation 会把 `requestedSchema.properties` 映射成带稳定字段 ID 的问答页，提交时还原 string/number/integer/boolean/array 类型并发送 `{action:"accept", content}`；可选字段由 schema 的 `required` 决定。URL elicitation 只在用户点击提交动作后打开目标 URL，取消或 unsupported schema 发送 `{action:"cancel", content:null}`，不会自动接受或把 URL 当作普通模型文本。

原生 plan item 与 `turn/plan/updated` TODO 分开保存。`item/plan/delta` 先显示 preview，`item/completed` 以同一 native item ID 权威替换；权威正文在当前 thread 上显示“Execute plan”和“Continue adjusting”。执行按钮通过 `execute_codex_plan` 单飞校验 thread/plan 身份，然后以 default collaboration mode 发起一次新的 native turn，不改变原 approval preset 或 sandbox selection。

前端同步清除 runtimeReset、failed runtime 和同一计划回合失败/中断时的执行入口；成功完成的计划继续保留，其他 root 的状态不影响当前计划。文件批准预览读取原生 kind.type/movePath。单文件撤销保存各自的提交账本，不同文件可并行；回执只移除实际撤销的 keys。单文件或批量派发失败立即解除等待，保留记录，不自动重发。

执行计划按每次提交的 requestId 接受回执，成功/异常/提前失败均回传原 requestType/threadId/requestId；旧会话结果不结束当前等待，当前原生拒绝原因会显示。手动压缩保留 interrupted/cancelled 的原生 outcome，显示已中断。撤销的相对路径和 moveFrom 固定到提交时工作目录，EDT 等待期间切换目录不改变写入目标。

直接索引工具结果 `{i,result:actualResult}` 与原有 Promise 回执共用实际槽位关联，不将最终输出重新显示为 exec。原生生成图片显示开始、PNG/保存路径和失败终态；原生 error 通知显示完整原因，继续等待回合终态。子代理卡片与底部列表复用 Claude 表现并共享原生身份、状态和摘要，保留跨回合仍在运行的代理。

模型目录、技能和 MCP 状态使用独立的只读 native data 事件。Codex 选择器发送 `codex_native_list_models`，返回的 `data` 只描述当前有效运行时可见的模型，不代表账户 entitlement；技能和 MCP 设置分别使用 `codex_native_list_skills`、`codex_native_mcp_status` 与显式 `codex_native_mcp_reload`。inactive 或鉴权错误不会静默启动 legacy exec。

历史列表优先走 `thread/list`，页面保留 `source=native`、`nextCursor` 和 `partial`。cursor 原样传回，重叠 turn/item 页按 native id upsert；metadata-only 空页不会清除现有记录。只有 runtime access inactive 时才请求已有只读 legacy 列表，鉴权/writer 错误保持可见。

设置页的 Codex 访问范围统一为 `read-only`、`workspace-write`、`danger-full-access`，旧 `set_codex_sandbox_mode` 仍兼容但同时发出带 `source=user` 的 `set_codex_sandbox_selection`。计划/批准选择不会改写 sandbox，页面显示迁移来源。

旧 JSONL history adapter 只在 inactive、离线或原生投影明确缺失时提供只读回退；它不会重新执行任务，也不自动与 native history 拼接。旧 adapter 在未加载新 privacy index 的版本中不提供本版本的 secret 遮蔽保证，回退文案必须明确这一边界。

`/diff` 走 `codex_read_workspace_diff` 独立 Java handler，基于当前 effective cwd 读取 Git staged、unstaged 和 untracked 快照，带大小/超时上限；它不创建模型回合，也不复用旧 turn 的 diff。非 Git 目录通过独立结果事件返回明确状态。

## 边界行为补充

会话展示行为：编辑账本独立读取全部原生 fileChange，checkpoint 以操作身份保存，删除/移动/EOF 与冲突撤销依据实际 patch；ImageView 的空终态可完成。Codex 文本使用完整 item 快照，结束时提交整个待处理列表；Guardian 目录按来源过滤并重建旧缓存。用户气泡共用 Claude 主题，单条/批次命令共用外层 shell 显示清理，纯轮询不创建卡片或分隔线。首次成功新会话在现有开关和授权下异步生成标题，用原生 thread/name/set 保存，手动名称优先，释放时取消辅助请求。

输出片段不表示命令完成；明确终态及空的 MCP 结果仍会收尾。失败/中断只更新当前操作尚未结束的工具，已结束回合的运行时输出缓存会释放。异步批准预览以请求实例校验租约，原生 resolved 使旧回调失效，同一 RPC ID 后续使用不受旧回调影响。

旧 wrapper 仅在操作完整可确认且结果可关联时被替换。具有独立 FileChange/CommandExecution/ImageView 或结构化结果的已知混合调用恢复为共用卡片；Promise 数组按实际槽位配对，空输入轮询更新原命令。历史来源选择按已恢复的具体调用身份判断，额外 exec 数量不能覆盖完整投影。缺少独立结果的混合类型、多补丁、动态输入或不确定对象保留完整通用卡片和输出，其中静态补丁可另行灰色预览，不把共同结果归给各补丁。CRLF、顶层 Script failed 错误封套、结构化失败及未配对输入缓存预算均纳入处理。不同明确时间的 compact 记录继续独立显示。实时/历史图片共用原生 URL、legacy image_url、base64/source 和 localImage 转换，清理正文时保留附件；不完整文件变化整体回退通用卡片并保留状态。

原生控制指令不依赖共享 SDK 安装查询；/compact、/review、/diff 桥接无法派发时显示错误，不提示“已开始”或生成模型消息。目录重复 cursor/页数限制/桥接派发失败会结束 loading 并显示错误。/diff 同时排空 Git stdout/stderr，输出各自受限，结果按会话对象、sessionId 和 cwd 校验。dynamic/collab started 和失败/中断收尾进入同一工具显示路径；receiver 存在不能替代启动调用的 completed 状态，父回合的收尾也不改变仍活动的 child。
