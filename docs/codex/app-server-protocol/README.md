# app-server 协议开发参考（来源记录）

## 生成来源

- CLI：`codex-cli 0.111.0`（官方 npm 包 `@openai/codex`，2026-10-01 生成）。
- 命令：
  - `codex app-server generate-ts --out docs/codex/app-server-protocol/generated/ts`
  - `codex app-server generate-json-schema --out docs/codex/app-server-protocol/generated/schema`
- 本地核对源（只读，不作为运行时依赖）：`E:/project/codex/codex-rs/app-server-protocol/src/protocol/common.rs`（服务端请求方法 1765–1784）、`v2/thread.rs`（thread/start.sandbox，94）、`v2/turn.rs`（collaborationMode experimental 261–265）。

## 本次实施核对的关键合同

| 合同 | 生成类型 | 与官方源码一致性 |
|---|---|---|
| 服务端请求方法 | `ServerRequest.ts`: `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` | common.rs:1765–1784 ✓ |
| thread API | `ClientRequest.ts`: `thread/start`、`thread/resume`、`thread/list`、`thread/read`、`thread/compact/start`、`thread/unsubscribe`、`turn/start`、`turn/interrupt` | ✓ |
| sandbox 大小写 | `v2/ThreadStartParams.sandbox?: SandboxMode`，`SandboxMode = "read-only" \| "workspace-write" \| "danger-full-access"`（kebab-case 字符串）；`v2/TurnStartParams.sandboxPolicy?: SandboxPolicy`（camelCase 字段名） | v2/thread.rs:94 ✓ |
| collaboration settings | `CollaborationMode = { mode: "plan" \| "default", settings: Settings }`，`Settings = { model, reasoning_effort, developer_instructions }`（snake_case）；`turn/start.collaborationMode` 标注 experimental | v2/turn.rs:261–265 ✓ |
| 交互 decision union | `CommandExecutionApprovalDecision = "accept" \| "acceptForSession" \| {acceptWithExecpolicyAmendment} \| {applyNetworkPolicyAmendment} \| "decline" \| "cancel"` | ✓ |
| 用户输入 | `UserInput = {type:"text"} \| {type:"image",url} \| {type:"localImage",path} \| {type:"skill",name,path} \| {type:"mention",name,path}` | ✓ |
| 压缩 | `v2/ThreadCompactStartParams = { threadId }`（无聚焦参数） | ✓ |

## 使用范围

实现只参考生成类型；运行时不 import 这些 `.ts` 文件。Node 实现以本目录类型为协议边界，fixtures 构造以 JSON schema 为准。

## 版本化脱敏 trace（traceVersion 1）

共享 trace 供 Node peer、Java 集成与前端 Vitest 三层解析（任务 1.6）：

- 规范 fixture：`ai-bridge/services/codex/testing/trace/fixtures/appserver-trace-v1.ndjson`
- 解析器：Node `codex-trace-format.js`、Java `CodexTraceFixtureTest`、webview `codexTraceFixture.test.ts`
- 首行为 header `{"traceVersion":1,...}`，其后每行一个事件，字段含 `t`（相对毫秒）、`kind`（client_message / notify / response / server_request / server_response / interaction_show / interaction_close / secret_marked / workspace_diff / exit 等）。
- fixture 覆盖：延迟 ID（notify 先于 ack）、child 请求（parentThreadId + string server id）、消息 clientMessageId（两条不同）、show/close 单调 sequence + resolved tombstone、混合 secret 标记、工作区 diff 计数、root/child 各一个 turn/completed。
- 脱敏合同：事件只含身份、方法、方向、计数与 secret 标志，不含答案正文、凭证或用户内容。
