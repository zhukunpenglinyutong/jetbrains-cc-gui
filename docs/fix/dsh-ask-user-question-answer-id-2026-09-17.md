# DSH 提问在 cc-gui 中「答了等于没答」问题分析与修复记录

**日期**: 2026-09-17
**版本**: v0.5.6 之后
**状态**: 根因已定位并修复（答案编码）；3 项次生风险已记录待评估
**涉及 Provider**: `dsh`（DeepSeek Harness，modern 线协议 ≥ 0.1.5）

---

## 一、用户反馈

> 在 cc-gui 里没法作答 DSH 提的问题，只能到 dsh-web 那边操作；虽然弹了问题，但答复无效。

先说结论：**弹窗、选项点选、提交、Java 侧 IPC 这条链路是通的**（下面的真实会话记录可以证明），坏在最后一跳——Node 桥把答案回填给 DSH host 时，**答案的 `id` 用错了**，用成了「问题正文」，而 DSH 要求回填提问方自己声明的 `question.id`。模型拿到的是一批它从未声明过的 id，无法把答案对回到自己的问题上；多问题批次、需要 free-text 的场景直接读不出有效答复，用户于是回到 dsh-web 重新回答。

---

## 二、根因

答案的编码在两处语义不一致：

| 环节 | 代码 | 行为 |
| --- | --- | --- |
| 前端弹窗（与 Claude 共用） | `webview/src/components/AskUserQuestionDialog/answerState.ts#formatAnswers` | 以**问题正文**为 key 产出答案对象；「其他」自由文本被塞进标签数组 |
| DSH 桥（修复前） | `ai-bridge/services/dsh/events.js#mapQuestionAnswers` | 直接把这个 key 当成 DSH 的答案 `id` 发出 |

DSH 的协议契约（`@deepseek-ai/dsh-user-questions`）：

- `AskUserQuestionItem.id`：「Stable caller-provided question id, **echoed in the answer**」——必须原样回填；
- `AskUserQuestionAnswerItem`：`{ id, selected: string[], custom?: string }`；
- **单选**题里 `custom` 会**取代**所选项，此时 `selected` 必须为空；多选题 `custom` 可与 `selected` 并存。

而 cc-gui 桥发出去的是 `{id: "<问题正文>", selected: [...]}`——正文当 id，自由文本当选项。对照 DSH 官方 Web 客户端（`dsh-client-ui-user-questions`）：它发的永远是 `{ id: item.id, selected, custom? }`。

---

## 三、证据

### 1. 真实会话记录（`~/.dsh/sessions/**/session*.jsonl.zstd`）

这些日志是**多帧 zstd 容器**（每条记录一帧），必须先按帧头结构切分再逐帧解码，单次 `zstdDecompressSync` 只能拿到 header 帧。

扫描 119 个 transcript（36 个含 `ask_user_question` 调用），对所有工具返回做形状分类：

| 答案形状 | 数量 | 来源 |
| --- | --- | --- |
| `id` = 提问方声明的 id（合法） | 72 | dsh-web 客户端 |
| `id` = **问题正文**（本次 bug） | 2 | cc-gui 插件 |
| `{"answers":[]}` | 2 | 取消 / 兜底 |
| 调用被中断（aborted / interrupted） | 14 | 用户打断轮次 |

两处插件形状的实例，都是 cc-gui 驱动的会话：

- `session-73f99e35`（`D:\code\广排\psgs-analyze-server`，2026-09-16）
- `session-bacd2ec0`（`D:\code\广排\psgs-server-v2`，2026-09-17）

以 2026-09-17 那次（`id: prescheck` / `otherfix` 两个问题）为例，DSH 实际收到的是：

```json
[
  { "id": "兜底现在是「静默跳过」（…）。要不要再加一道前置检查改成主动提示？", "selected": ["只做提示，部分生效（推荐）"] },
  { "id": "另外两个发现要不要我一并修掉？（可多选）", "selected": ["追溯接口 isReceived 恒为 0（String 用了 ==）", "…"] }
]
```

模型的反应也印证了这一点（transcript seq=522）：它只能靠选项文案和顺序硬猜归属，并抱怨「你选了那条描述里说要一并告知的选项，但没告诉我」——即答复内容不完整、不可核验。

用修复后的映射重放同一份真实输入：

```json
{ "answers": [
  { "id": "prescheck", "selected": ["只做提示，部分生效（推荐）"] },
  { "id": "otherfix",  "selected": ["追溯接口 isReceived 恒为 0（String 用了 ==", "批量取消的 findTopByUsidInOrderByIdDesc 只取 1 条"] }
] }
```

### 2. 线上 host 探针（排除传输层嫌疑）

对正在运行的 `http://127.0.0.1:3080` 用插件自签的浏览器会话 cookie 发 `POST /api/$events/result`：

| 载荷 | host 响应 |
| --- | --- |
| `{args:{clientId,eventId,outcome}}`（插件实际发送的形状） | 通过解析，报 `Remote event result identifies no active event stream`（仅因 clientId 是伪造值） |
| `{clientId,eventId,outcome}`（裸形状） | `Remote event result requires exactly one plain-object args field` |

结论：**封包形状是对的**，`answerWaterfall` 的 `$events/result` 调用没有问题；坏的只是答案内容。

---

## 四、修复

`ai-bridge/services/dsh/events.js`：

1. `mapQuestionAnswers(answers, questions)` 增加 `questions` 入参，按**问题正文 → 声明 id** 反查，输出的 `id` 一律是提问方声明的 id；
2. 用该题的 `options[].label` 集合区分「选项」与「其他自由文本」：命中选项进 `selected`，未命中进 `custom`；单选题存在 `custom` 时 `selected` 置空（与官方 Web 客户端一致）；
3. 批次里未作答的问题补 `{ id, selected: [] }`（镜像 Web 客户端），对话框整单取消时仍发 `{ answers: [] }`，保住「没有答案」与「全部跳过」的区别；
4. 若没有任何问题能匹配上（legacy host、或非 DSH 形状的旧载荷），退回原行为（按 key 原样投递），不丢人的答案。

调用点同步传参：`bridgeDshQuestion`（legacy `respond`）与 `bridgeModernQuestion`（modern `$events/result`）。

### 回归测试

- `ai-bridge/services/dsh/events.test.js`：新增 `mapQuestionAnswers` 单元用例——声明 id 回填、单选 custom 覆盖、多选 custom 并存、无选项问题全自由文本、跳过项、取消为空、无匹配时回退。
- `ai-bridge/services/dsh/question-bridge.test.js`（新增）：模拟 Java 侧 IPC（认领请求文件 → 按前端 key 写答案文件），断言 host 收到的 `$events/result` 值与 `respond` 值；另断言请求文件逐字携带模型声明的 `questions`。

验证：

- ✅ `node --test ai-bridge/services/dsh/*.test.js`：114/114 通过（修复前 105 + 新增 9）
- ✅ `node --test`（全部 ai-bridge 测试）：759 tests / 756 pass / 3 skipped / 0 fail

> 数字以本分支基线 `feature/v0.5.7` 为准（`main` 与本分支的既有测试数量不同）。

---

## 五、次生风险（后续已在本 PR 内修复）

前三条已在同一 PR 内补修（提交 `7cbe7ef5` / `acfa628b` / `61f355ef`）：

1. **`turn.clientId` 未就绪时答案被静默丢弃** —— ✅ 已修（`7cbe7ef5`）：`answerWaterfall` 原来在 `$events` 未收到 `ready` 帧时直接 `return false`（日志只在 Node stderr，IDE 侧不可见），用户在弹窗里答完却被丢弃。现在 approval / question 两个 bridge 都会**先有界等待**（`CLIENT_ID_WAIT_MS = 3s`，`resolveClientId()` 接受 id 或取值函数）拿到当前 generation 的 clientId 再弹窗；等不到就记日志并且**不弹窗**（不会让用户答一个注定发不出去的答案）。`message-service` 改为传 `() => turn.clientId`，等的是实时值而非帧到达时的快照。
2. **`dialogToken` 不匹配被静默吞掉** —— ✅ 已修（`61f355ef`）：`PermissionHandler.handleAskUserQuestionResponse` 的静默 `return` 拆成两种可诊断分支（requestId 不存在 / token 与 pending 不一致），各打一条 WARN；语义不变（仍忽略，且保留 pending 请求给复用了同一 requestId 的新弹窗），但排查时不再需要靠"缺日志"反推。
3. **DSH 的 `detail` / `intent` 被前端丢弃** —— ✅ 已修（`acfa628b`）：`normalizeQuestion` 保留 `detail` 与归一化后的 `intent`；`QuestionSection` 用现有 `MarkdownBlock` 在选项上方渲染计划正文（plan-review 带「计划内容」标题，面板限高可滚动）；`provider` 现在从 `permission-ipc` 一路透传到弹窗（两个 bridge 都发 `dsh`），标题不再把 DSH 说成「Claude 有一些问题想问你」。

仅剩第 4 条作为**同类症状线索**保留（Claude 长驻 daemon 的 routing id 漂移，与 DSH 无关）：
4. **孤立 IPC 文件（Claude 路径，非 DSH）**：`%TEMP%\claude-permission\ask-user-question-307c1658-…json`（2026-09-15 11:49，cwd `D:\code\广排\psgs-server-v2`）未被任何 watcher 认领。其 questions 没有 `id` 字段，是 Claude 的 AskUserQuestion 形状（DSH 的 `id` 是必填、且经 JSON 无损校验，缺 id 的请求根本到不了插件），说明是 Claude 侧长驻 daemon 的 `CLAUDE_SESSION_ID` 与当时 watcher 的 routing id 漂移。DSH 每轮新起进程、不受此影响，仅作为同类症状的另一条线索记录。

---

## 六、真机（IDE 内）验证 ✅

2026-09-17 做了两轮验证。

**1. 密闭端到端（不需要真实 host、不花 token）**

本地 mock DSH host（HTTP + `/api/remote.mux`）+ 真实的 `channels/dsh-channel.js → message-service → events.js`，由脚本扮演 Java 侧与弹窗（答案按问题正文做 key、自由文本混进标签——即弹窗的真实形状）。同一份脚本分别跑两份 bridge：

| 目标 | host 实收 id | 结果 |
| --- | --- | --- |
| 仓库（已修复） | `prescheck, otherfix, cadence, unused` | PASS |
| 安装目录副本（修复前） | 三个问题正文（第 4 题整题丢失） | FAIL |

**2. IDE 内真机一轮**

- 15:10:30 插件从 cc-gui 发起 DSH 轮次（日志 `sendToCli provider=dsh, cwd=D:\code\jetbrains\jetbrains-cc-gui-v2`），bridge 进程来自已打补丁的安装目录（`[dsh] Command: …\plugins\idea-claude-code-gui\ai-bridge\channel-manager.js dsh send`）。
- session `session-2754c72b-235a-41c7-b745-6e8157d655f4`：模型声明 `id=abc_test`（3 选项、单选），DSH 实收

  ```json
  {"answers":[{"id":"abc_test","selected":["A. 选项 A —— 能正常点选"]}]}
  ```

- 模型随后正确读到答复并汇报「控件工作正常」——id 与声明一致，提问→渲染→点选→结构化回填闭环。

---

## 七、如何在你的环境里复核

1. **快速复核（不必重新打包）**：`<pluginDir>\ai-bridge\.bridge-version` 记录的是 `0.5.6:<ai-bridge.hash>`，两者一致时 `BridgeDirectoryResolver` 会跳过重新解压，因此直接把修复后的 `ai-bridge/services/dsh/events.js` 覆盖到 `<pluginDir>\ai-bridge\services\dsh\`（先备份原文件）即可；DSH 每轮现开 `channel-manager.js` 进程，下一轮提问即生效，**无需重启 IDE**。正式发布仍走 `./gradlew buildPlugin`（`packageAiBridge` 会重新生成 `ai-bridge.zip` + `ai-bridge.hash`）。
2. 在 cc-gui 里触发一次 `ask_user_question`，选择选项并提交。
3. 到 `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd` 里看 `tool/result`：`id` 应等于模型声明的 id（如 `abc_test`），自由文本应出现在 `custom` 字段，未作答的问题应为 `{id, selected: []}`。修复前这里一定是问题正文。

> 读取技巧：该文件每条记录一个 zstd 帧，需按帧结构切分后逐帧解码（可参考 `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js#scanZstdFrames`）。

---

## 八、同一个 PR 内一并修复：waterfall 未按会话过滤（弹错窗口）

**症状**：cc-gui 里弹窗「串窗口」——别的会话提的问题/审批弹到了当前窗口；dsh-web 侧正常，因为它按会话作用域订阅。用户视角是「虽然有提问，但答复无效 / 不是我这边问的却在我这弹」。

**根因**：`$events` 是 **host 全局流**。gateway 把每个 forwarded waterfall 广播给**所有** `$events` 客户端（`deliverRemoteEvent` 遍历 `remoteEventClients`），而 `subscribeModernStreams` 的 `$events` 处理器对 `approval/request` / `user-questions/request` **没有任何归属判断**，收到就 `bridgeModernQuestion` / `bridgeModernApproval` → 弹到当前窗口，并且 **host 用第一个结果 settle waterfall**，所以插件还会把别的会话的答案抢掉。

归属可判定：DSH 源码 `@deepseek-ai/dsh-api-session-controller/lib/scope.js` 明确写着 —— *"agent and its session share one id (1:1, same axis; no separate AgentId ...)"*，而 gateway 构造 waterfall 帧时带上 `agentId: source.context.agentId`（`dsh-api-gateway/lib/index.js`），因此帧里的 `agentId` **就是** 该请求所属的 sessionId。

**修复**：

- `events.js` — `projectRemoteEventFrame()` 把帧里的 `agentId` 一并带出；新增导出 `waterfallBelongsToSession(agentId, sessionId)`（缺失 `agentId` 的旧 host 按旧行为接受）。
- `message-service.js` — `$events` 处理器在进入 approval/question 分支前过滤：不属于本会话的请求记一条 `[dsh] ignoring a … for session … (this turn serves …)` 后忽略。**忽略 ≠ 拒绝**：该请求在本客户端仍保持 pending，由真正拥有它的客户端回答。`ready` / `cancel` 逻辑不变；`lastActivityAt` 改为只在本会话帧上更新，避免别家流量掩盖自家静默。
- `events.test.js` — 帧形状带 `agentId` + 归属判定真值表。

**验证（本地 mock host，同一次运行同时推「别的会话」与「本会话」两个 waterfall）**：

| bridge | 弹窗收到的题目集合 | 结论 |
| --- | --- | --- |
| 修复前（已安装副本，仅有答案映射修复） | `[["foreign"], ["prescheck","otherfix","cadence","unused"]]` 且 `foreign waterfall answered here: true` | 弹错窗口**并替别人作答** |
| 修复后 | `[["prescheck","otherfix","cadence","unused"]]` + 忽略日志 | 只处理本会话 |

同一 mock 还断言了答案编码（声明 id 回填、`custom` 承载自由文本、未作答补 `{id, selected: []}`）。dsh 套件 115/115；全量 ai-bridge 760 tests / 757 pass / 3 skipped / 0 fail。

> 影响面提醒：**approval 走同一条流** —— 修复前别的会话的授权请求会弹到当前窗口，用户点「允许」等于替别人批准了工具调用。本次过滤同时覆盖两类 waterfall。

---

## 九、同一条链路第三个缺陷：提问控件里「手动输入与选项联动不上」

**症状**：弹窗出现 1/2/3 选项 + 一行「其他」手动输入时，用户反馈「手动输入的没办法联动」——打了字却像没生效。

**复现**（真实渲染 + 点击，记录 `onSubmit` 实际提交内容）：

| 操作 | 修复前 | 修复后 |
| --- | --- | --- |
| 点「其他」→ 手输 → 提交 | `{"Q":"我自己的答案"}` | 同（本来就通） |
| 点「其他」→ 手输 → **再点选项1** → 提交 | `{"Q":"1. 选项一"}`，输入框消失，**文本被静默丢弃** | `{"Q":"1. 选项一"}`，输入框同步清空（所见即所交） |
| 想「选 1 + 补一句」 | **输入框根本不存在** | 输入框常显，一打字自动选中「其他」 |
| **无选项的自由问答**（DSH 最常见） | **必须先点「其他」**才出现输入框，不点则提交按钮禁用 | 不渲染「其他」行，输入框常显且自动聚焦 |
| 多选：选项1 + 手输 | 需先点「其他」 | `["1. 选项一","补充说明"]` |

**根因**（`webview/src/components/AskUserQuestionDialog/`）：

1. `QuestionSection.tsx` 把输入框写成 `{isOtherSelected && …}` —— 只有「其他」被选中才渲染；
2. `answerState.toggleAnswerSelection` 在单选下是 `clear() + add(label)`：点普通选项会抹掉「其他」标记 → 输入框卸载；
3. `formatAnswers` 只在「标记还在」时才带上文本 → 文本静默丢失；且没有「打字即选中其他」的联动。

**修复**：输入框常显（无选项的题隐藏「其他」行并自动聚焦）；打字自动置上「其他」标记（单选下按协议替换已选选项，因为该题只能携带一个值）；单选点普通选项时清空输入框，避免留下"看着还在、其实不会提交"的幽灵文本；`formatAnswers` 改为「文本一定随答案走」（单选 custom 覆盖选项、多选 labels + custom）；`canProceed` 只要有文本即可提交；点「其他」行同 tick 聚焦。

**真机验证**（session `session-2754c72b-235a-41c7-b745-6e8157d655f4`，cc-gui 内实际作答；两题批次 + 上一步回退改选）：

```json
{"answers":[{"id":"back_test_q1","selected":["C. 改后的答案"]},
            {"id":"back_test_q2","selected":[],"custom":"正常"}]}
```

回退到上一题把 B 改成 C 后提交的是 **C**（状态未丢）；自由文本以 `custom` 送达（说明手动输入确实随答案提交）。

**测试**：`webview/src/components/AskUserQuestionDialog.otherInput.test.tsx`（10 例）；全量 webview 182 个测试文件 / 1586 tests 全过；`npm test`（含 `tsc` 类型检查）退出码 0。

---

## 十、核心文件

- `ai-bridge/services/dsh/events.js`（`mapQuestionAnswers` 重写 + 两个 bridge 调用点传参；`projectRemoteEventFrame` 带出 `agentId` + `waterfallBelongsToSession`）
- `ai-bridge/services/dsh/message-service.js`（`$events` 按会话过滤 waterfall；活动时间只计本会话帧）
- `ai-bridge/services/dsh/events.test.js`（新增 5 个映射用例 + 归属判定用例）
- `ai-bridge/services/dsh/question-bridge.test.js`（新增集成用例 4 个）
- `webview/src/components/AskUserQuestionDialog/QuestionSection.tsx`（输入框常显；无选项时免「其他」行 + 自动聚焦）
- `webview/src/components/AskUserQuestionDialog/useAskUserQuestionState.ts`（打字即选中「其他」；单选点选项清空文本；文本即可提交）
- `webview/src/components/AskUserQuestionDialog/answerState.ts`（`syncOtherSelection`；`formatAnswers` 文本必随答案）
- `webview/src/components/AskUserQuestionDialog.otherInput.test.tsx`（新增交互回归用例 10 个）
