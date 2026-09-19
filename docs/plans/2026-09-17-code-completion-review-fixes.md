# 代码补全（DeepSeek FIM）审查修复方案

> **日期**: 2026-09-17
> **状态**: P1-1 / P1-2 / P1-3 已实施（见文末「实施状态」）；P2 待办
> **审查对象**: `feat/code-completion-platforms` 工作区里未提交的实现（v1 9/8 + v2 9/17 平台支持）
> **关系**: 补充 `2026-09-17-code-completion-platform-support-design.md`，不替代其设计结论
> **分支策略**: 本方案只落在功能分支上；其余分支（`feature/code-completion-platforms` 旧名、`fix/*` 遗留）暂不清理

---

## 0. 摘要

方向正确：设计里最易踩的两个坑（**`path` 缺失时按 host 优先推导**、**预置表只在 webview**）都落住了并有回归测试。但 v2 的两个卖点在真实交互/真实数据下**不成立**，编辑器侧另有资源与阻塞问题。风险等级：中（无崩溃、无越权）。

| 编号 | 问题 | 严重度 | 是否必须本 PR 修 |
| --- | --- | --- | --- |
| P1-1 | 「测试连接」测的是磁盘上已保存的配置，不是界面上编辑中的值 | 高（唯一排障手段失真） | ✅ |
| P1-2 | 凭证复用的 host 匹配漏了 `settingsConfig.env` 与 codex 两种真实结构 | 高（功能对多数 provider 无声失效） | ✅ |
| P1-3 | 编辑器侧 2.5s 阻塞不可取消、commonPool 承载阻塞 IO、每次新建 `HttpClient` | 中（资源累积 + 延迟归属） | ✅ |
| P2 | 12 项（日志/超时矛盾/前端卡"测试中"/死代码/校验缺口/文案等） | 低~中 | 择要 |

**合并门槛**：P1-1 / P1-2 / P1-3 必须修完并补测试；P2 见第 4 节（建议至少带上标注"本轮"的 5 项）。

---

## 1. P1-1 「测试连接」必须测当前编辑值

### 现状与证据

- `webview/src/components/settings/CodeCompletionSection/index.tsx:191-195`：`handleTest` 只发 `window.sendToJava?.('test_code_completion:')`，**不带 draft、也不先保存**。
- `handler/SettingsHandler.java:349`：`case "test_code_completion": projectConfigHandler.handleTestCodeCompletionSettings();` —— **不传 content**。
- `handler/ProjectConfigHandler.handleTestCodeCompletionSettings()`：`settingsService.getCodeCompletionSettings()` 读**持久化**配置，再 `CodeCompletionCredentialResolver.resolve(settings)`。
- 同文件 `:138 / :173-183`：切换平台下拉只改 draft（`applyPreset`），不重新解析凭证 → 会出现「显示 DeepSeek 端点 + 提示已复用自 SiliconFlow」的错配提示。

### 实测影响（现场配置为证）

本机 `~/.codemoss/config.json` 当前是 `source=custom` + `baseUrl=https://api.siliconflow.cn/`。因此在界面上切到「DeepSeek 官方」再点「测试连接」，**实际请求仍打到 SiliconFlow**，返回 200 就得出"DeepSeek 配置可用"的错误结论 —— 而这是 v2 唯一的排障手段。

### 方案（推荐 A，可叠加 C 的提示）

- **A（推荐）命令携带 draft**：前端 `test_code_completion:${JSON.stringify(draft)}`；`SettingsHandler` 把 `content` 传给 handler；handler 解析 JSON → 构造**临时** `CodeCompletionSettings`（**不写盘**）→ 用它解析凭证并发起测试。
  - draft 里 `apiKey` 可能是掩码（`****`）：掩码时回退用**已存 key**，其余字段一律以 draft 为准。
  - JSON 解析失败：回退到已存配置，并在结果里带 `warning` 说明"测的是已保存配置"。
- **B（备选）先保存再测**：`handleTest` 先 `handleSave()` 再测。缺点：为了一次测试改写用户配置，语义差。
- **C 叠加**：draft 与已存配置不一致时，按钮旁提示"将测试未保存的当前设置"，并在切换平台时**重新解析凭证**（修掉 `resolvedFrom` 陈旧）。

### 验证

- 前端单测：切换平台后点测试 → 断言发出的 payload 含新 `preset/baseUrl/path`；断言 UI 在 dirty 时的提示文案。
- Java 单测：`handleTestCodeCompletionSettings(draftJson)` 用 draft 覆盖（新增，目前零测试）。
- 手工：把 baseUrl 改成一个必然失败的值（如 `https://127.0.0.1:1`）**先不保存**直接测试 → 必须失败，证明确实在测 draft。

---

## 2. P1-2 凭证复用补齐真实数据结构

### 三种真实结构（本机 config.json 实测 + 代码核对）

| provider 来源 | 结构 | 现有 `pick()` 是否命中 |
| --- | --- | --- |
| cc-switch 导入（当前全部 Claude provider 都是） | 顶层 `baseUrl` / `apiKey`（另有 `settingsConfig.env`） | ✅ 命中 |
| 插件 UI 内新建/编辑的 Claude provider | 仅 `settingsConfig.env.{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}` | ❌ `sameHost("")` 恒 false |
| **全部 codex provider** | 仅 `configToml`（`base_url = "..."` 在字符串里）+ `authJson`（`{"OPENAI_API_KEY":...}`） | ❌ 连 host 都取不到 |

现有实现（`settings/CodeCompletionCredentialResolver.java`）：
- `:90` 只用 `stringOf(p, "baseUrl")` 取 host；
- `:102-119 extractToken` 找**顶层** `apiKey`，再找**顶层** `env`（真实嵌套是 `settingsConfig.env`）；
- `:136-138 sameHost` 是**双向 `endsWith`**：会把 `api.deepseek.com` 的 key 匹配给 `deepseek.com`（反向子域），且 `hostOf` 丢弃端口。

### 改动点

1. **host 来源**按优先级取第一个非空：顶层 `baseUrl` → `settingsConfig.env.ANTHROPIC_BASE_URL` → `settingsConfig.env.OPENAI_BASE_URL` → codex `configToml` 里的 `base_url = "..."`（正则提取，取最后一个/首个匹配需固定并加测试）。
2. **token 来源**按优先级：顶层 `apiKey` → `settingsConfig.env.{ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKey}` → codex `authJson` 解析出的 `OPENAI_API_KEY`。
3. **host 归一与匹配**：大小写不敏感、忽略尾斜杠；端口策略显式化（建议保留端口参与比较，或至少写测试固定行为）；子域匹配改为**单向**（`providerHost` 以 `targetHost` 结尾或相等），避免反向误配。
4. 命中后仍遵守既有约定：UI 只显示掩码 + "已复用自 `<provider name>`"；用户手动改过 key 后不再自动覆盖。

### 验证（补测试形状，这是本次漏网的直接原因）

- 三种形状各一条：cc-switch 顶层、UI 自建 `settingsConfig.env`、codex `configToml`+`authJson`。
- `sameHost`：相等 / 正向子域 / **反向子域（应为 false）** / 端口 / 大小写 / 尾斜杠。
- 现有测试只造了"顶层 baseUrl + 顶层 env"的形状，**必须保留但不再作为唯一形状**。

---

## 3. P1-3 编辑器侧的阻塞与资源

### 现状与证据

- `completion/FimCompletionContributor.java:121-127`：`future.get(REQUEST_TIMEOUT_MS=2500ms)`；超时后**不 cancel**，底层 HTTP（`DeepSeekFimClient.HTTP_TIMEOUT_MS=5000`）继续跑；`e.getMessage()` 在 `TimeoutException` 下为 `null` → 日志打 "null"。
- `provider/common/DeepSeekFimClient.java:83`：`CompletableFuture.supplyAsync(...)` 未指定 executor → **`ForkJoinPool.commonPool()`** 承载阻塞 IO。
- 同文件 `:197-200`：**每次调用** `HttpClient.newBuilder()...` + `client.send(...)`（阻塞）。
- `:111 / :131`：在补全的后台线程读 `editor.getCaretModel().getOffset()`；平台在同一方法里已提供 `parameters.getOffset()`（`:97` 已在用）。
- `plugin.xml` 的注释声称 `order="last"` 能让内置补全"不被慢请求拖慢" —— **理由不成立**：平台在整轮 contributor 结束后才显示 lookup；`id`/`order` 属性本身合法（已对 IDEA 243 EP 校验），但措辞需要订正。

### 方案

1. **Transport 增加异步通道**：`interface Transport` 增加 `CompletableFuture<HttpResult> postAsync(url, apiKey, body, timeoutMs)`（默认实现可用 `sendAsync` + `orTimeout`），保留同步方法给既有测试。
2. **超时参数化**：编辑器路径 `2000ms`（≤ 编辑器预算）、测试连接 `15000ms`；`HTTP_TIMEOUT_MS` 常量退化为默认值，不再同时充当两条路径的硬上限（修掉"15s 是死代码"）。
3. **`HttpClient` 共享**：客户端持有单个 `HttpClient`（或构造注入），不再每次 `newBuilder()`。
4. **超时即取消**：`catch (TimeoutException)` 分支显式 `future.cancel(true)`；改用 `sendAsync` 后该取消能真正终止 HTTP 交换。
5. **`parameters.getOffset()` 替换** `:111/:131` 的 `editor.getCaretModel().getOffset()`，消除"后台线程读 CaretModel"的 EDT 疑点（该疑点已给出确认方法：`-Didea.is.internal=true` 时在 `:111` 前断言 `assertIsDispatchThread()`，但既然平台提供了正确 API，直接替换更划算）。
6. **失败可诊断**：`LOG.debug` 带 `httpStatus` 与错误原文（对齐设计 §7）。

### 备选（最小改动）

保留阻塞实现，仅：HTTP 超时降到 ≤2000ms、超时 `cancel(true)`、共享 `HttpClient`、换 `parameters.getOffset()`。可作为第一提交，异步化留作后续。

### 验证

- 单测：注入一个"慢响应"的 `Transport` 实现（已在 `DeepSeekFimClientTest` 有注入缝），断言超时后 future 被取消、且不再持有线程。
- 手工：连续快速触发补全（打字/连按 Ctrl+Space）观察是否堆积；关掉网络后确认编辑器无卡顿且 debug 日志有状态码。

---

## 4. P2 清单

| # | 位置 | 问题 | 修法 | 本轮 |
| --- | --- | --- | --- | --- |
| 1 | `DeepSeekFimClient:89,106-109` | 编辑器路径丢弃 `httpStatus/error`，无 debug 日志（与设计 §7 冲突） | 日志带上状态码与错误 | ✅ |
| 2 | `ProjectConfigHandler:601-604` | 异常分支只 `showError`，不推 `onCodeCompletionTestResult` → 前端**永久"测试中"** | 异常也推一次结果（`ok:false`） | ✅ |
| 3 | `index.tsx:191-195` | 只依赖回调复位 `setTesting(false)` | 加本地兜底超时（>15s）复位 | ✅ |
| 4 | `CodeCompletionSettings:134-136` | 只在 model 为空时补默认值；存量 `deepseek-v4-flash` 不迁移（**现场就是这个值**） | 增加"已知失效模型名 → 提示或迁移" | ✅ |
| 5 | `FimCompletionLogic.computeInsertOffset` + `FimCompletionLogicTest:52-56` | 主代码零引用的死代码 + `assert 3==3` 恒真断言 | 删除死代码，补真实插入语义测试（含 `result.getPrefixMatcher().getPrefix().isEmpty()` 守卫） | ✅ |
| 6 | `index.tsx:173-181` | 切 Custom 时 baseUrl 留空走"保留旧值"分支 → 静默产出 404 组合 | 显式置空/提示必填 | ⬜ |
| 7 | `ProjectConfigHandler:543-549` | 已存 key 无法清空（空值一律视为"保留"） | 增加显式清除入口 | ⬜ |
| 8 | `CodeCompletionSettings:117-122`、`DeepSeekFimClient:132-134` | `baseUrl` 无 scheme 校验；`path` 未拒 `//host`、`..` | 补校验（实测不构成 SSRF，但与设计 §9 措辞不符） | ⬜ |
| 9 | `plugin.xml:97-103` | `language="any"` 让 `.env/.txt` 等前缀也发往第三方端点；注释理由不成立 | 收窄语言/文件类型 + 订正注释 | ⬜ |
| 10 | `FimCompletionContributor:83`、`CodeCompletionCredentialResolver:40` | 每次补全两次全量配置读 + 两次全文拷贝 | 短期缓存 + 只在必要处取文本 | ⬜ |
| 11 | `ProjectConfigHandler:624-628` vs `ClaudeSettingsManager:342` | `maskApiKey` 逐字节重复（设计说"沿用"） | 提取共用工具 | ⬜ |
| 12 | `buildElement` 文案 | SiliconFlow 下仍显示 "DeepSeek FIM"；80 字符硬截断 | 文案按平台/或中性化 | ⬜ |

---

## 5. 明确不做（YAGNI）

- 不做多厂商 FIM 抽象、流式补全、chat 伪 FIM、按语言分配平台（沿用 v2 §3 结论）。
- 不改 DSH/Claude/Codex 宿主配置；本功能只读用户显式填写（或按 host 复用）的凭证。
- 不动 "key 是否回传 webview" 的既有其它路径（`handleGetProviders` 对 cc-switch provider 的行为是既有设计，另案讨论）。

---

## 6. 实施顺序与提交拆分建议

| 提交 | 内容 |
| --- | --- |
| 1 | `fix(code-completion): test the edited settings, not the saved ones`（P1-1 + 前端 payload/提示 + 前端测试） |
| 2 | `fix(code-completion): reuse credentials from every provider shape`（P1-2 + 三种形状测试 + host 归一） |
| 3 | `fix(code-completion): cancel a timed-out FIM request and stop blocking commonPool`（P1-3 + 慢 Transport 单测 + `parameters.getOffset()`） |
| 4 | `fix(code-completion): surface failures and drop dead code`（P2 #1-#5） |
| 5 | `chore(code-completion): tighten path/baseUrl validation, i18n and wording`（P2 #6-#12，可选） |

每个提交后跑：`./gradlew test --tests "*CodeCompletion*" --tests "*Fim*"` 与 `cd webview && npm test`。

---

## 7. 待人工确认的开放问题

1. **CaretModel EDT**：`FimCompletionContributor:111/131` 在后台线程读 `CaretModel` 是否触发平台断言（确认法：`-Didea.is.internal=true` 时在 `:111` 前插 `assertIsDispatchThread()`；若断言触发会被 `:61-63` 的 catch 吞掉 → FIM 永远不出建议）。**倾向直接改用 `parameters.getOffset()`**，但请确认是否影响"用户在等待期间继续输入"的既有判定语义。
2. **平台 lookup 是否在首轮 pass 前增量显示**：决定 P1-3 的"延迟归属"要归给谁（若平台会等我们，则 2.5s 就是用户可感知的输入延迟）。
3. **存量错误 model 如何处置**：现场是 `model=deepseek-v4-flash` + SiliconFlow（该平台正确 id 形如 `deepseek-ai/DeepSeek-V4-Flash`）。是"仅提示"还是"按平台预置自动纠正"？建议只提示，避免擅自改用户配置。
4. **端口是否参与 host 匹配**：`hostOf` 目前丢弃端口；同机多网关（如 `127.0.0.1:8317`）场景下是否要区分？

---

## 附：现场配置建议（非代码问题）

`~/.codemoss/config.json` 的 `codeCompletion` 当前为 `source=custom` + `baseUrl=https://api.siliconflow.cn/` + `model=deepseek-v4-flash`。SiliconFlow 的 FIM 模型 id 形如 `deepseek-ai/DeepSeek-V4-Flash` / `Qwen/Qwen3-Coder-30B-A3B-Instruct`，`deepseek-v4-flash` 很可能直接 400/404 —— 这可以解释"配好了没反应"。修完 P1-1（能测当前编辑值）后，建议先在 UI 里改用平台预置的模型名再测试。

---

## 实施状态（2026-09-17）

| 项 | 状态 | 落点 |
| --- | --- | --- |
| P1-1 测试连接测当前编辑值 | ✅ 已实施 | `CodeCompletionSection/index.tsx`（`test_code_completion:<draft>`、用结果里的 `apiKeyResolvedFrom` 刷新提示）、`SettingsHandler` 透传 content、`ProjectConfigHandler.draftOrStoredSettings(...)`（掩码/空 key → 用已存 key；不可解析 → 回退已存配置）、`code`…`CodeCompletionSettings.maskApiKey/looksMasked/keepStoredKeyWhenMasked`（同时消掉与 `ClaudeSettingsManager` 之外那处重复实现） |
| P1-2 凭证复用补齐真实结构 | ✅ 已实施 | `CodeCompletionCredentialResolver.hostOfProvider/tokenOfProvider/envValue`：顶层 `baseUrl`/`apiKey` → `settingsConfig.env`（ANTHROPIC/OPENAI）→ codex `configToml`（正则取 `base_url`）+ `authJson`（解析取 `OPENAI_API_KEY`）；`sameHost` 改为**单向**子域匹配并加入端口比较 |
| P1-3 编辑器侧阻塞与资源 | ✅ 已实施 | `DeepSeekFimClient`：共享 `HttpClient`、`Transport.post(..., timeoutMs)` 非阻塞、请求级超时（编辑器 2000ms < contributor 的 2500ms 等待；测试连接 15000ms，去掉死代码 `orTimeout`）、超时映射为可读错误；`FimCompletionContributor` 用 `parameters.getOffset()` 替代后台线程读 `CaretModel` |
| 测试 | ✅ | Java：`CodeCompletionCredentialResolverTest`（三种真实形状 + 端口 + 反向子域）、`ProjectConfigHandlerCodeCompletionTest`（新增，draft 优先/掩码/回退）、`DeepSeekFimClientTest`（预算透传、超时可读）、`CodeCompletionSettingsTest`；前端：`CodeCompletionSection/index.test.tsx` 增加「切换平台后测的是屏上值」「复用提示随测试结果刷新」 |

**验证**：`./gradlew test --tests "*CodeCompletion*" --tests "*Fim*"` → BUILD SUCCESSFUL；`webview: npm test`（见提交时的实测记录）。P2 清单见第 4 节，尚未实施。
