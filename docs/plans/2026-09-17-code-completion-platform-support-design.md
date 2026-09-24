# 代码补全：平台支持与「测试连接」设计

> 状态：待用户审查。前置实现见 `2026-09-08-deepseek-inline-completion-design.md`（v1 已完成并安装）。

## 1. 背景与目标

v1 的编辑器内联补全已落地（`FimCompletionContributor` + `DeepSeekFimClient`），但端点路径被**硬编码**为 `{baseUrl}/beta/completions`，凭证来源只有 `deepseek` / `custom` 两个选项。

目标：让补全能对接更多**真实支持 FIM 的平台**，并且当用户配置错误时**能看见原因**（v1 把 HTTP 404 静默吞掉，导致"界面没反应"，排查代价很高）。

## 2. 实测调研结论（本次逐家用真实 key 探测）

协议形状统一为 **OpenAI 兼容 completions**：`POST {base}{path}`，body `{model, prompt, suffix, max_tokens, temperature, top_p, stop, ignore_eos, stream:false}`，响应取 `choices[0].text`。

| 平台 | 探测 | 结论 |
|---|---|---|
| DeepSeek 官方 | `POST /beta/completions` → **200**，`text="  return a+b;\n"` | ✅ 保留（预置） |
| SiliconFlow | `POST /v1/completions` → **200**，`text="\n    return a + b;\n"` | ✅ 保留（预置） |
| SiliconFlow + `Pro/zai-org/GLM-5.1` | → **400** `suffix is not allowed` | ⚠️ 该模型不支持 FIM（换模型即可） |
| SiliconFlow + `Qwen/Qwen3-Coder-30B-A3B-Instruct` | → **200** 多行补全 | ✅ 可用 |
| SiliconFlow + `moonshotai/Kimi-K2-Instruct` / `MiniMaxAI/MiniMax-M2` | → **403** `Model disabled` | ❌ 不可用 |
| 火山方舟（Coding Plan key） | `/api/coding/v3/completions` → **404** | ❌ 剔除（无 FIM） |
| MiniMax | `/v1/completions` → **404** `page not found` | ❌ 剔除（无 FIM） |
| Kimi / GLM / Claude / OpenAI / OpenCode Zen | 官方文档仅 chat(`/chat/completions`)、`/messages`、`/responses`，无 completions | ❌ 剔除（不做 chat 伪 FIM） |

补充事实（影响配置与提示）：
- Ark 的 Coding Plan key **只能**用于 `/api/coding`（Anthropic）与 `/api/coding/v3`（OpenAI 兼容）；在 `/api/v3` 上返回 `API key format is incorrect`。
- DeepSeek 官方可用模型仅 `deepseek-flash`、`deepseek-v4-pro`（`GET /models` 实测）；`deepseek-v4-flash` 是 **Zen 的**模型 id，官方不存在。v1 的默认值是错的，本设计修正。
- SiliconFlow `/v1/models` 实测 94 个模型。
  > ⚠️ **2026-09-18 更正**：本节原先写「支持 FIM 的包含 `DeepSeek-V3`、`DeepSeek-V3.2`、`DeepSeek-V4-Flash`、`Qwen3-Coder-30B-A3B-Instruct`」，这一条是**错的**——模型广场里有 ≠ 支持 FIM。带 `suffix` 逐模型实测后，`DeepSeek-V3.2` / `DeepSeek-V4-Flash` 均返回 `400 20031 FIM is not supported for this model`。实测表与结论见 `2026-09-18-code-completion-fim-models.md`。

## 3. 范围

**做**
1. 配置从「凭证来源二选一」升级为 **平台预置**：`deepseek`（官方）、`siliconflow`、`custom`。
2. 端点路径不再硬编码：新增 `path` 字段（DeepSeek 预置 `/beta/completions`，其余默认 `/v1/completions`）。
3. **「测试连接」按钮**：真实发起一次 FIM 调用，回显 HTTP 状态码、错误原文、返回片段。
4. **凭证复用**：选择预置平台后，自动在插件已配置的 provider 列表中按 host 匹配并复用其 `apiKey`，UI 显示复用来源；匹配不到则手填。
5. 修正默认模型为 `deepseek-flash`。

**不做（YAGNI）**
- chat 提示词伪 FIM、Anthropic `/messages`、OpenAI `/responses`、Gemini 原生协议适配器（无 FIM 能力，用户已明确剔除）。
- 流式补全、多平台并发/回退链、按语言分配平台。
- 平台探测自动化（改由「测试连接」人工一键验证）。

## 4. 配置数据模型

`CodeCompletionSettings`（`codeCompletion` section）字段变更：

| 字段 | 变更 | 说明 |
|---|---|---|
| `preset` | **新增** | `deepseek` \| `siliconflow` \| `custom`，默认 `deepseek` |
| `path` | **新增** | 端点路径，默认 `/v1/completions`；`deepseek` 预置为 `/beta/completions` |
| `source` | **移除**（保留迁移读取） | 旧值 `deepseek`/`custom` → 映射为 `preset` |
| `baseUrl` | 保留 | 默认 `https://api.deepseek.com` |
| `apiKey` / `model` / `maxTokens` / `temperature` / `topP` / `stop` / `ignoreEos` / `debounceMs` | 保留 | 语义不变 |

**迁移规则**（`fromJson` 内）：
- `preset` 缺失时读旧 `source`（`deepseek`→`deepseek`，`custom`→`custom`，其余→`deepseek`）。
- `path` 缺失时**按 baseUrl 主机优先、其次按 preset** 推导：
  - host 为 `api.deepseek.com`（或 `preset=deepseek`）→ `/beta/completions`
  - 其余 → `/v1/completions`

  > 只按 `preset` 推导会把现存可用配置改坏：实测环境中用户当前是 `source=custom` + `baseUrl=https://api.deepseek.com/`（打的是官方 `/beta/completions`），仅凭 `preset=custom` 会推出 `/v1/completions` 而 404。故必须看主机。

迁移后 `normalize()` 保证 `path` 以 `/` 开头且不以 `/` 结尾、`baseUrl` 无尾斜杠。

端点拼接：`buildEndpoint(baseUrl, path)` = `trimTrailingSlash(baseUrl) + ensureLeadingSlash(path)`。

`preset` 在 Java 侧视为**受校验的不透明字符串**（仅允许 `deepseek` / `siliconflow` / `custom`，越界回退 `deepseek`），不参与请求构造。

**预置表位置**：UI 侧（webview TS）持有平台预置（baseUrl、path、模型建议），Java 侧只存"已解析的最终值"（baseUrl/path/model）+ 上述迁移推导 —— 避免两处维护同一张表。

## 5. 凭证复用

选择预置平台时，Java 侧按 host 在 `claude.providers` / `codex.providers` 中查找 `baseUrl` host 相同的 provider，取回 `apiKey`（Ark/GLM 等 provider 的 model 存放在 `settingsConfig.model`，本功能不读取 model）。

- 命中：回填 key（UI 仍只显示掩码），并提示"已复用自 <provider name>"。
- 未命中：保持空，要求手填。
- 用户手动改过 key 后不再自动覆盖。

## 6. 「测试连接」

新增 bridge：`test_code_completion` → 在后台线程用当前配置发起一次极小的 FIM 调用（`prompt="public static int add(int a, int b) {"`、`suffix="}"`、`max_tokens=32`）→ 通过 `window.onCodeCompletionTestResult` 回推：

```json
{ "ok": true,  "httpStatus": 200, "snippet": "    return a + b;\n", "endpoint": "https://.../beta/completions" }
{ "ok": false, "httpStatus": 404, "error": "HTTP 404", "endpoint": "..." }
```

UI 就地展示状态、错误原文与返回片段。这是排查"配置了没反应"的主要手段（v1 缺此能力导致必须翻日志/手工 curl）。

超时上限 15s（测试用，比编辑器内 5s 宽松）。

## 7. 编辑器侧

`FimCompletionContributor` 逻辑不变（BASIC 补全触发、非标识符位置、2.5s 上限、注入 LookupElement）。
- 改为使用 `path` 组装端点。
- 失败仍**静默**（不打断输入），但补 `LOG.debug`（含 HTTP 状态），便于开 debug 后定位。
- 默认模型修正为 `deepseek-flash`。

## 8. UI 变更（CodeCompletionSection）

- 凭证来源 → **平台下拉**：DeepSeek 官方 / SiliconFlow / 自定义。
- 选预置：自动填 `baseUrl`、`path`、模型建议（datalist），并尝试复用 key。
- 自定义：`baseUrl` + `path` 手填。
- 新增 **「测试连接」** 按钮 + 结果区（成功显示返回片段；失败显示状态码与错误原文）。
- 保留：启用开关、API Key（掩码 + "留空即保留"）、模型、Max tokens、Temperature、Top P、Ignore EOS、保存。

## 9. 错误处理与安全

- API Key 永不明文回传 webview（沿用 `maskApiKey`）；日志与测试结果中不出现 key。
- 测试连接返回的 `error` 截断到 500 字符。
- `path` 只允许以 `/` 开头的相对路径（拒绝 `http://` 等绝对 URL，避免 SSRF 式误配置）。

## 10. 测试策略

后端（JUnit，纯逻辑，无需 IDE 运行时）：
- `CodeCompletionSettings`：新字段默认值、`path` 归一化、`source → preset` 迁移、JSON round-trip。
- **`path` 缺失时的推导**：`host=api.deepseek.com` → `/beta/completions`；其它 host → `/v1/completions`；并含回归用例「旧配置 `source=custom` + `baseUrl=https://api.deepseek.com/` 迁移后不被打坏」。
- `preset` 校验：非法值回退 `deepseek`。
- `buildEndpoint(baseUrl, path)`：尾斜杠/前斜杠各种组合、`path` 为绝对 URL 时被拒绝。
- 响应解析：200 正常、`choices` 为空、非法 JSON、非 200 → `null`。
- 凭证匹配：host 相等/子域/不匹配（用纯函数，避免依赖真实配置）。

前端（vitest）：
- 平台切换联动（预置填充 baseUrl/path/模型；自定义可编辑）。
- 「测试连接」三种状态渲染（进行中 / 成功含片段 / 失败含错误）。
- 保存 payload 含 `preset`/`path`。

## 11. 变更文件清单

新增：无（平台预置表放在现有 section 内）。

修改：
- `src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java`（`preset`/`path` + 迁移 + 默认模型修正）
- `src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java`（`buildEndpoint(baseUrl, path)`、错误信息带状态码）
- `src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java`（测试连接、凭证复用匹配）
- `src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`（`test_code_completion` case）
- `webview/src/components/settings/CodeCompletionSection/index.tsx`（平台下拉、测试连接、结果区）
- `webview/src/global.d.ts`（`onCodeCompletionTestResult`）
- `webview/src/i18n/locales/{en,zh}.json`
- 对应测试文件

## 12. 风险与开放问题

- **平台能力会变**：SiliconFlow 的 FIM 模型列表可能调整（`suffix is not allowed` / `Model disabled` 都是运行期才知道）。设计上以「测试连接」兜底，不追求静态正确。
- **未验证平台**：Zen / Kimi / GLM / OpenAI / Claude 未实测（无 key）。若日后实测发现某家支持 completions，只需在预置表加一行即可接入，无需改动客户端。
- **默认模型**：`deepseek-flash` 依据 `GET /models` 实测；若官方调整模型名，用户可在设置里改。
