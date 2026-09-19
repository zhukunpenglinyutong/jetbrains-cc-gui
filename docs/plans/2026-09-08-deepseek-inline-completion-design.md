# CC GUI 编辑器内联代码补全（DeepSeek FIM）设计

> **日期**: 2026-09-08
> **状态**: 修订版 v2（已落实评审结论 + 用户决策）
> **范围**: 在 IntelliJ 编辑器中实现基于 DeepSeek FIM（Fill-in-the-Middle）补全 API 的编辑器内联代码补全 MVP。
>
> **修订记录**：
> - v2（本版）：根据设计评审修正 5 处关键问题（P0/P1/P2），并落实用户两项决策——FIM 模型用 `deepseek-v4-pro` / `deepseek-v4-flash`；凭证来源仅保留 `deepseek` 与 `custom`。

## 1. 需求背景

当前 CC GUI 插件为 Claude Code / Codex / DeepSeek Harness 等 AI 编码 CLI 提供了可视化聊天界面，但**没有任何编辑器内联代码补全**能力（grep 到的 "completion" 均为 `CompletionException` 或任务完成通知；聊天输入框的历史补全不属于代码补全）。

用户希望在本插件中补充"代码补全"能力，方向为**完整的编辑器内联补全**，后端使用 **DeepSeek FIM API**。凭证来源经评审收敛为**仅两种**：DeepSeek 官方 / 用户自定义（不再提供"跟随 Claude/Codex provider"，因其端点不支持 DeepSeek `/beta/completions`，几乎必然失效）。

## 2. 目标

- 在编辑器中实现基于 DeepSeek FIM 补全 API 的灰色内联代码补全提示，Tab 接受，Esc 取消。
- 提供独立的"代码补全"配置 UI，可配置凭证、FIM 参数、防抖。
- 凭证来源支持：**DeepSeek 官方默认** / **自定义**（两种）。
- 复用项目已有的 `java.net.http.HttpClient` HTTP 调用模式与配置读写模式。

## 3. 非目标（YAGNI）

- 不做多厂商 FIM backend 抽象（仅 DeepSeek `/beta/completions`）。后续可扩展。
- **不支持**"跟随 Claude / Codex / DSH provider 作为补全凭证来源"——它们端点不支持 DeepSeek FIM。
- 不做补全结果的"接受后格式化/AI 重排"等高级功能。
- 不修改 DSH / Claude / Codex 宿主本身的配置，仅读取用户显式填写的 DeepSeek 凭证。
- 不做补全历史、用量统计。
- **不做 `manual` 手动触发模式**——内联补全的本质是光标处自动出现灰色内联提示，`triggerMode` 字段已从配置中移除（YAGNI，避免定义无意义的快捷键）。

## 4. 架构总览

三层结构 + 一层设置 UI，职责清晰、边界明确：

```
┌──────────────────────────────────────────────────────────┐
│ ① 配置层  CodeCompletionSettings (纯DTO/校验/默认值)          │
│    CodemossSettingsService (持久化读写)                       │
│    存储 source / baseUrl / apiKey / model / FIM参数 / enable  │
│    / debounce                                                │
└──────────────────────────┬───────────────────────────────┘
                           │ 读配置
                           ▼
┌──────────────────────────────────────────────────────────┐
│ ② FIM 调用层  DeepSeekFimClient                            │
│    java.net.http.HttpClient → POST {baseUrl}/beta/completions│
│    入参: prefix(prompt) / suffix / model / temperature / ... │
│    出参: choices[0].text                                     │
└──────────────────────────┬───────────────────────────────┘
                           │ 取结果（异步, 可取消）
                           ▼
┌──────────────────────────────────────────────────────────┐
│ ③ 编辑器集成层  InlineCompletionManager                     │
│    CaretListener + DocumentListener  →  防抖触发            │
│    InlayModel 显示灰色内联提示   Tab接受 / Esc取消           │
└──────────────────────────┬───────────────────────────────┘
                           ↕
┌──────────────────────────────────────────────────────────┐
│ ④ 设置 UI  CodeCompletionSection (webview React)            │
│    经现有 bridge event 与 Java 交互                         │
└──────────────────────────────────────────────────────────┘
```

## 5. 配置层

### 5.1 职责划分

- **`CodeCompletionSettings`**：纯 DTO。持有字段，提供静态默认值与校验方法，**不直接读/写配置文件**。
- **`CodemossSettingsService`**：负责持久化。负责从 JSON 配置读写 `codeCompletion` section，并把 `JsonObject` 与 `CodeCompletionSettings` 相互转换（参照现有 `ClaudeSettingsManager` / `CodexSettingsManager` 的模式）。

### 5.2 数据存储

在 `CodemossSettingsService` 管理的 JSON 配置中新增 `codeCompletion` section。字段及默认值：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 总开关 |
| `source` | string | `"deepseek"` | 凭证来源：`deepseek`（官方）/ `custom`（自定义）。仅两种 |
| `baseUrl` | string | `"https://api.deepseek.com"` | FIM 端点基址 |
| `apiKey` | string | `""` | FIM API Key |
| `model` | string | `"deepseek-v4-flash"` | FIM 模型。候选：`deepseek-v4-flash`（默认，延迟敏感首选）/ `deepseek-v4-pro`（质量优先） |
| `maxTokens` | int | `256` | 补全最大 token 数 |
| `temperature` | double | `1.0` | 采样温度 |
| `topP` | double | `1.0` | 核采样概率 |
| `stop` | string[] | `["\n\n"]` | 停止序列，默认在空行处截断，避免过度生成 |
| `ignoreEos` | boolean | `false` | 是否忽略 EOS 标记 |
| `debounceMs` | int | `300` | 输入防抖（毫秒） |

> **说明**：`triggerMode`（`auto`/`manual`）已移除。内联补全只工作在自动模式，不提供手动触发器（见 §3 非目标）。

### 5.3 凭证来源解析（核心逻辑）

`source` 决定 baseUrl 与 apiKey 的取值：

| source | baseUrl 来源 | apiKey 来源 | 备注 |
|---|---|---|---|
| `deepseek` | 配置 baseUrl（默认 `https://api.deepseek.com`） | 配置 apiKey | **官方默认路径**，UI 直接填 DeepSeek key |
| `custom` | 用户显式填写（可为第三方兼容 DeepSeek FIM 的端点） | 用户显式填写 | 完全自定义，形如 `deepseek` 但允许换端点/模型 |

> **不再提供 `followClaude` / `followCodex`**：二者的 baseUrl 指向 Anthropic / OpenAI，不支持 DeepSeek `/beta/completions`，且其 API Key（`ANTHROPIC_*` / OpenAI token）与 DeepSeek 不通用，沿用必然 401。故取消，符合 YAGNI，也避免给用户必然失效的开关。DSH 走 `dsh` section 无 FIM 端点，同样不提供。

### 5.4 配置读写接口

在 `CodemossSettingsService` 上新增（遵循现有 getter/setter 风格）：

- `getCodeCompletionConfig()` → 返回 `CodeCompletionSettings`（含默认值填充）。
- `setCodeCompletionConfig(CodeCompletionSettings)` → 校验 + 写回 JSON。
- `getCodeCompletionConfigJson()` / `setCodeCompletionConfigJson(JsonObject)` → 供 webview bridge 存取。
- 各字段 `getXxx()/setXxx()`（如 `isCodeCompletionEnabled()`、`setCodeCompletionEnabled(boolean)`）。

## 6. FIM 调用层：`DeepSeekFimClient`

### 6.1 请求

复用 `java.net.http.HttpClient`（项目已在 `PetdexRepository`、`ClaudePlanUsageService`、`TokenTrackerHandler` 等处使用）。

- **URL**: `POST {baseUrl}/beta/completions`（默认 `https://api.deepseek.com/beta/completions`）。
- **认证**: `Authorization: Bearer <apiKey>`。
- **Content-Type**: `application/json`。
- **请求体**:

```json
{
  "model": "deepseek-v4-flash",
  "prompt": "<代码前缀>",
  "suffix": "<代码后缀>",
  "max_tokens": 256,
  "temperature": 1.0,
  "top_p": 1.0,
  "stop": ["\n\n"],
  "ignore_eos": false,
  "stream": false
}
```

> **FIM 参数说明**：DeepSeek FIM 接口使用 `prompt` 承载前缀、`suffix` 承载后缀。`model` 为可配置项，候选 `deepseek-v4-flash` / `deepseek-v4-pro`。若兼容端点不支持 `suffix`，可退化为仅传 `prompt`（前缀续写）；该回退由解析层决定。

### 6.2 出参

解析 `choices[0].text` 作为补全文本。**补全文本是"中间片段"**，即应插入在**前缀与后缀之间**，且默认从光标处开始续写。为控制端到端延迟，MVP 用 `stream=false`。

> **决策记录**：内联补全对延迟敏感。若实测（`stream=false`）延迟超过 ~500ms，需在实现计划中评估切换 `stream=true` + 增量渲染的决策点。MVP 先按非流式落地。

### 6.3 错误与取消处理

- 每个请求返回/持有可取消的 `CompletableFuture<String>`。
- 401（未授权）/404（端点不存在）/超时/IO 异常：**静默取消**，不下发内联提示（不打断用户）。
- 新输入到达或用户移动光标：主动 `cancel()` 旧请求。
- 限制请求频率：由 debounce 控制，避免打爆 API。

### 6.4 接口签名（示意）

```java
public final class DeepSeekFimClient {
    public CompletableFuture<String> complete(
        String prefix, String suffix,
        CodeCompletionSettings cfg,
        CancellableClientTracker tracker
    );
}
```

## 7. 编辑器集成层：`InlineCompletionManager`

### 7.1 注册

- 项目打开时挂载 `DocumentListener` / `CaretListener` 到 `EditorFactory.getInstance().getEventMulticaster()`（参考 `EditorContextTracker` 现有用法）。
- 通过配置读取 `enabled` 开关；关闭时不注册/不触发。

### 7.2 触发流程

1. `DocumentListener.documentChanged` / `CaretListener.caretPositionChanged` 收到事件。
2. 判断是否满足触发条件：光标不在行尾、前后有足够上下文、非空行等。
3. 启动防抖定时器（`debounceMs`）。防抖窗口内新输入则重置定时器。
4. 防抖到期 → 取当前编辑器 `Document` 中光标前文本（前缀）与光标后文本（后缀）。
5. 调用 `DeepSeekFimClient.complete(...)`。
6. 结果返回时，若光标位置未变化，用 `InlayModel` 在当前偏移插入灰色内联提示。

### 7.3 展示与交互（含精确插入语义）

- 用 `InlayModel` 在光标偏移处插入灰色 `InlineHint`（与 IDE 主题一致）。
- **插入语义（关键）**：FIM 返回的 `choices[0].text` 是**中间补全片段**，应插入在**前缀与后缀之间**（即原光标位置），**而不是替换前缀或后缀区间**。前缀在上、后缀在下，中间补全自然填充空缺。Tab 接受时：
  - 将补全文本插入到光标偏移（前缀末尾 / 后缀开头）；
  - 光标移动到插入内容末尾；
  - 清除提示。
  - 若实际模型返回的是"前缀续写"（无后缀场景），同样在光标处插入即可（后缀为空时等价于前缀续写）。
- **Esc 取消**：清除提示、取消进行中的请求。
- **光标移动**：清除已显示的提示、取消进行中的请求。

> **为何不是"替换当前 offset"**：直接 Replacing 会把后缀（光标后的代码）顶掉，产生错误代码。FIM 的定位就是中间填充，必须保留后缀。

### 7.4 并发与生命周期

- 持有当前进行中的 `CompletableFuture`；新触发时取消旧的。
- 配置变更（`set_code_completion_settings`）时重载配置并关闭未完成的请求。
- 项目关闭时注销 listener、清理 inlay、取消请求。

## 8. 设置 UI —— `CodeCompletionSection`（webview）

### 8.1 组件与布局

在设置页面新增 `CodeCompletionSection.tsx`（参考现有 `PromptEnhancerSection` / `OtherSettingsSection` 的结构）。**挂载点**：`SettingsSidebar` 新增一个 section 入口（参照现有各 section 的注册方式），并把组件加入设置主内容区的 section 渲染列表中。

- 开关：启用/停用代码补全。
- 凭证来源下拉：`DeepSeek 官方` / `自定义`。
- 依据 source 显示 baseUrl / apiKey 输入框（`deepseek` 时默认官方端点；`custom` 时可改端点/模型）。
- `model` 下拉/输入：候选 `deepseek-v4-flash` / `deepseek-v4-pro`，可自定义。
- maxTokens、temperature、topP、stop、ignoreEos。
- 防抖（ms）。

### 8.2 bridge 交互

- Java 侧 `SettingsHandler` 新增 case（该文件用 string 分发，见 L165 `switch(type)`，新增 case 完全兼容）：
  - `get_code_completion_settings` → 返回当前 `codeCompletion` 配置。
  - `set_code_completion_settings:<json>` → 校验并保存。
- WebView 侧通过现有 `bridge.ts` 发送事件、接收回调。

### 8.3 i18n

在 `webview/src/i18n/locales/{en,zh,zh-TW,...}.json` 的 `settings` 块中补充 `codeCompletion` 文案（含 groupTitle、字段 label、hint）。

## 9. 测试

### 9.1 单元测试（Java）

- `DeepSeekFimClientTest`：
  - 请求体组装（prefix→prompt、suffix→suffix、`model` 透传、`stop` 默认 `["\n\n"]`）。
  - 响应解析（`choices[0].text`）。
  - 401/超时/异常 → 静默取消、无补全。
  - `cancel()` 后 future 完成异常处理。
- `CodeCompletionSettingsTest`：
  - 默认值读取、非法值回退、`source` 枚举校验（仅 `deepseek`/`custom`，其余拒绝）。
  - `source=deepseek` 官方端点、`source=custom` 自定端点的解析。
- `InlineCompletionManagerTest`：
  - 防抖合并、取消旧请求、光标移动即清除。
  - **插入语义**：验证中间补全插入在前缀/后缀之间、不替换后缀。

### 9.2 前端测试（webview）

- `CodeCompletionSection.test.tsx`：
  - 渲染与字段联动（source 切换时字段显隐）。
  - 保存回调 payload 正确。

## 10. 实现计划入口（后续）

本设计批准后，将拆分实现计划，覆盖：配置层 Java、FIM client、编辑器集成、设置 UI、i18n、测试。各文件将遵循现有包结构与编码规范。

## 11. 变更文件清单（预估）

- `src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java`（新文件，DTO + 默认值 + 校验）
- `src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java`（新增 `codeCompletion` 读写 + 与 DTO 互转）
- `src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java`（新文件）
- `src/main/java/com/github/claudecodegui/ui/InlineCompletionManager.java`（新文件）
- `src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`（新增 `get_/set_code_completion_settings` case）
- `src/main/resources/META-INF/plugin.xml`（如需注册编辑器扩展点）
- `webview/src/components/settings/CodeCompletionSection/index.tsx`（新文件）
- `webview/src/components/settings/SettingsSidebar/index.tsx`（挂载 section 入口）
- `webview/src/components/settings/SettingsHeader/index.tsx` 或设置主内容区（渲染新 section）
- `webview/src/i18n/locales/*.json`（补充文案）
- 对应测试文件

## 12. 风险与开放问题

- **FIM 端点与模型名确认**：DeepSeek FIM 为 Beta。`model` 采用用户指定的 `deepseek-v4-flash` / `deepseek-v4-pro`。**实现阶段需用用户提供的 API key 实测一次确认端点与模型名的可行性**（尤其 `/beta/completions` 与 `deepseek-v4-*` 模型的兼容性）。若实测异常，通过 `custom` 的 baseUrl/model 覆盖兜底。
- **`InlayHint` API 版本**：需在实现时核对项目依赖的 IntelliJ 2024.3 平台中 `InlayModel` / `InlineHint` 的可用签名（新 API 为 `InlayModel.addInlineElement`，旧 API 为 `InlayHintsProvider`）。以目标 IDE 编译为准。
- **Inlay 与原生补全冲突**：若用户启用 IDE 原生补全，两者可能同时显示；MVP 阶段允许叠加，后续可加开关。
- **API Key 安全**：沿用项目现状，apiKey 存于私有配置文件（0600），webview 回显一律脱敏（`maskCredential` 模式），不展示完整 key。
- **测试环境**：编辑器集成层的 `InlayModel` / `DocumentListener` 在无 IDE 环境下难以单测，需借助现有测试工具或抽离纯逻辑测试。

## 13. 待办（实现前需要用户提供）

- **DeepSeek API Key**：实现 S0 阶段实测 FIM 端点与 `deepseek-v4-flash` / `deepseek-v4-pro` 模型时，需要用户提供可用的 API key（仅用于本地验证，不入库）。

## 14. 落地变更记录（v3：编辑器集成改为 CompletionContributor 路线）

> 编码阶段按用户决策，将 §7「编辑器集成层」从 **Document/Caret listener + Inlay ghost-text** 改为 **CompletionContributor 原生补全项**。v2 设计稿中对应章节与下列文件以本节为准（v3），未列出的 v2 细节仍有效。

- **替换方案**：注册 `completion.contributor language="any"`（`order="last"`）→ `FimCompletionContributor`。BASIC 补全触发时同步调用 DeepSeek FIM（在补全 worker 线程执行、2.5s 上限），把返回的 middle fragment 作为一个原生 LookupElement 注入。接受/取消由 IDE 原生完成（Tab/Enter/Esc、光标移动即消失）。
- **触发条件（纯逻辑 `FimCompletionLogic`）**：
  - caret 前有非空白内容（`shouldSuggest`）；
  - caret 前**非标识符字符**（`isIdentifierCharBeforeCaret` 为 false）——正在打词时原生补全接管，FIM 不与词补全争抢；
  - 此时 typed prefix 为空，原生补全的默认插入语义（替换 typed prefix）恰好退化为「在 caret 处插入 middle fragment、保留前后文」，与 FIM 语义一致。
- **为何不用官方 ghost-text API**：`InlineCompletionProvider` 扩展点仅 2024.2+ 存在且为 Kotlin suspend API，本插件 sinceBuild=233 且为纯 Java。
- **替换/新增文件**：
  - 删除：`ui/InlineCompletionManager.java`、`ui/InlineCompletionManagerTest.java`（Inlay/DocumentListener 方案不再使用）；
  - 新增：`completion/FimCompletionLogic.java` + 测试、`completion/FimCompletionContributor.java`；
  - `plugin.xml`：`<completion.contributor .../>`（id `ccguiFimCompletion`，`order="last"`）。
- **debounceMs 说明**：CompletionContributor 由补全引擎自身节流，v3 不再使用 debounce；DTO/持久化仍保留该字段（未来如需 DocumentListener 自触发可复用），webview UI 不展示。
- **行为差异（相对 v2 直觉）**：建议出现在补全弹窗中（Ctrl+Space 或 IDE 自动弹补全），而不是键盘输入后自动出现的独立灰色文本；启用默认关闭，体验与原词补全共存。
- **UI 语义（v3 修正，以 design §8 + 本节为准）**：apiKey 输入框在 `deepseek`/`custom` 两 source 下均显示（官方端点同样需要 DeepSeek key）；baseUrl 仅 `custom` 显示（deepseek 固定官方端点）。回显 key 一律脱敏（`sk-ab****cdef`），留空/未改视为「保留已存 key」（后端 `ProjectConfigHandler` 处理）。
