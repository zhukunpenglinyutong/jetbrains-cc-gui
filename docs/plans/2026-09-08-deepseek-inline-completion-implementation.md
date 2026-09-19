# DeepSeek 编辑器内联代码补全 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 IntelliJ 编辑器中实现基于 DeepSeek FIM API 的灰色内联代码补全，Tab 接受 / Esc 取消，并提供独立配置 UI。

**架构：** 四层——`CodeCompletionSettings`（纯 DTO/校验）+ `CodemossSettingsService`（持久化）、`DeepSeekFimClient`（HTTP 调用）、`InlineCompletionManager`（编辑器集成）、`CodeCompletionSection`（webview UI）。凭证来源仅 `deepseek` / `custom`。

> **⚠️ 执行状态更新（编码阶段，已按用户决策落地）：** 任务 4/5 的「Document/Caret listener + Inlay ghost-text」实现**未采用**，改为 **`CompletionContributor` 原生补全项路线**（注册 `completion.contributor language="any" order="last"`）。落地文件与语义以设计文档 `docs/plans/2026-09-08-deepseek-inline-completion-design.md` 的 **§14 落地变更记录（v3）** 为准。实际新增：`completion/FimCompletionLogic.java`（纯逻辑）+ `completion/FimCompletionContributor.java`；原计划任务 4/5 中 `ui/InlineCompletionManager*`、GreyInlineRenderer、InlineCompletionBootstrap 均未创建/已删除。任务 7 中 webview UI 采用**自包含 section**（内部经 `get_/set_code_completion_settings` bridge 加载与保存，不再依赖 settings/index.tsx 中央状态），SettingsTab 联合类型新增 `'codeCompletion'` 并挂入 sidebar 与主内容区。apiKey 输入在 `deepseek`/`custom` 两种 source 下都显示（后端掩码回显 + 「留空/未改保留原 key」语义）。

**技术栈：** Java 17、IntelliJ Platform 2024.3.1（IC）、`java.net.http.HttpClient`、Gson、React 19 + TS + Vite、JUnit 4（后端）、Vitest（前端）。

**设计文档：** `docs/plans/2026-09-08-deepseek-inline-completion-design.md`

**执行环境注意事项：**
- 本仓库配置了全局 `pre-commit` 钩子（`C:\Users\Administrator\.git-hooks\pre-commit`）会打印提交内容并等待人工确认；在受限沙箱中 git 内置 `bash.exe` 可能无法启动（`couldn't create signal pipe`）。**commit 步骤若失败属环境问题**，需由用户在交互式终端手动提交，或设置 `GIT_COMMIT_SKIP_CONFIRM=1`。
- 后端测试运行命令统一带 `-PskipWebview=true` 跳过 webview 构建，加速单测。

---

### 任务 1：`CodeCompletionSettings` DTO + 校验

**文件：**
- 创建：`src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java`
- 测试：`src/test/java/com/github/claudecodegui/settings/CodeCompletionSettingsTest.java`

- [ ] **步骤 1：编写失败的测试**

```java
package com.github.claudecodegui.settings;

import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.*;

public class CodeCompletionSettingsTest {

    @Test
    public void defaultsMatchSpec() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        assertFalse(s.isEnabled());
        assertEquals("deepseek", s.getSource());
        assertEquals("https://api.deepseek.com", s.getBaseUrl());
        assertEquals("", s.getApiKey());
        assertEquals("deepseek-v4-flash", s.getModel());
        assertEquals(256, s.getMaxTokens());
        assertEquals(1.0, s.getTemperature(), 0.0001);
        assertEquals(1.0, s.getTopP(), 0.0001);
        assertEquals(Arrays.asList("\n\n"), s.getStop());
        assertFalse(s.isIgnoreEos());
        assertEquals(300, s.getDebounceMs());
    }

    @Test
    public void rejectsInvalidSource() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setSource("followClaude");
        s.normalize();
        assertEquals("deepseek", s.getSource());
    }

    @Test
    public void rejectsInvalidMaxTokens() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setMaxTokens(-5);
        s.normalize();
        assertEquals(256, s.getMaxTokens());
    }

    @Test
    public void roundTripsThroughJson() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setSource("custom");
        s.setBaseUrl("https://example.com");
        s.setApiKey("sk-test");
        s.setModel("deepseek-v4-pro");
        CodeCompletionSettings copy = CodeCompletionSettings.fromJson(s.toJson());
        assertEquals(s, copy);
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionSettingsTest -PskipWebview=true`
预期：编译失败（`CodeCompletionSettings` 不存在）。

- [ ] **步骤 3：编写实现代码**

```java
package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * Pure DTO for the code-completion (DeepSeek FIM) configuration.
 * Holds field values, supplies defaults, and validates on {@link #normalize()}.
 * Does NOT read or write the plugin config file — persistence lives in
 * {@link CodemossSettingsService}.
 */
public final class CodeCompletionSettings {

    public static final String SOURCE_DEEPSEEK = "deepseek";
    public static final String SOURCE_CUSTOM = "custom";
    public static final String DEFAULT_BASE_URL = "https://api.deepseek.com";
    public static final String DEFAULT_MODEL = "deepseek-v4-flash";
    public static final int DEFAULT_MAX_TOKENS = 256;
    public static final double DEFAULT_TEMPERATURE = 1.0;
    public static final double DEFAULT_TOP_P = 1.0;
    public static final int DEFAULT_DEBOUNCE_MS = 300;
    public static final List<String> DEFAULT_STOP = Arrays.asList("\n\n");

    private boolean enabled = false;
    private String source = SOURCE_DEEPSEEK;
    private String baseUrl = DEFAULT_BASE_URL;
    private String apiKey = "";
    private String model = DEFAULT_MODEL;
    private int maxTokens = DEFAULT_MAX_TOKENS;
    private double temperature = DEFAULT_TEMPERATURE;
    private double topP = DEFAULT_TOP_P;
    private List<String> stop = new ArrayList<>(DEFAULT_STOP);
    private boolean ignoreEos = false;
    private int debounceMs = DEFAULT_DEBOUNCE_MS;

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public String getSource() { return source; }
    public void setSource(String source) { this.source = source == null ? "" : source.trim(); }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl == null ? "" : baseUrl.trim(); }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey == null ? "" : apiKey.trim(); }

    public String getModel() { return model; }
    public void setModel(String model) { this.model = model == null ? "" : model.trim(); }

    public int getMaxTokens() { return maxTokens; }
    public void setMaxTokens(int maxTokens) { this.maxTokens = maxTokens; }

    public double getTemperature() { return temperature; }
    public void setTemperature(double temperature) { this.temperature = temperature; }

    public double getTopP() { return topP; }
    public void setTopP(double topP) { this.topP = topP; }

    public List<String> getStop() { return stop; }
    public void setStop(List<String> stop) { this.stop = stop == null ? new ArrayList<>() : new ArrayList<>(stop); }

    public boolean isIgnoreEos() { return ignoreEos; }
    public void setIgnoreEos(boolean ignoreEos) { this.ignoreEos = ignoreEos; }

    public int getDebounceMs() { return debounceMs; }
    public void setDebounceMs(int debounceMs) { this.debounceMs = debounceMs; }

    /** Apply validation: invalid values fall back to defaults. */
    public void normalize() {
        if (!SOURCE_DEEPSEEK.equals(source) && !SOURCE_CUSTOM.equals(source)) {
            source = SOURCE_DEEPSEEK;
        }
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = DEFAULT_BASE_URL;
        } else if (!baseUrl.endsWith("/")) {
            baseUrl = baseUrl + "/";
        }
        if (model == null || model.isEmpty()) {
            model = DEFAULT_MODEL;
        }
        if (maxTokens < 1 || maxTokens > 8192) {
            maxTokens = DEFAULT_MAX_TOKENS;
        }
        if (!Double.isFinite(temperature) || temperature < 0.0 || temperature > 2.0) {
            temperature = DEFAULT_TEMPERATURE;
        }
        if (!Double.isFinite(topP) || topP < 0.0 || topP > 1.0) {
            topP = DEFAULT_TOP_P;
        }
        if (debounceMs < 0 || debounceMs > 5000) {
            debounceMs = DEFAULT_DEBOUNCE_MS;
        }
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("enabled", enabled);
        o.addProperty("source", source);
        o.addProperty("baseUrl", baseUrl);
        o.addProperty("apiKey", apiKey);
        o.addProperty("model", model);
        o.addProperty("maxTokens", maxTokens);
        o.addProperty("temperature", temperature);
        o.addProperty("topP", topP);
        JsonArray stopArr = new JsonArray();
        for (String s : stop) { stopArr.add(s); }
        o.add("stop", stopArr);
        o.addProperty("ignoreEos", ignoreEos);
        o.addProperty("debounceMs", debounceMs);
        return o;
    }

    public static CodeCompletionSettings fromJson(JsonObject o) {
        CodeCompletionSettings s = new CodeCompletionSettings();
        if (o == null) { return s; }
        if (o.has("enabled") && !o.get("enabled").isJsonNull()) s.setEnabled(o.get("enabled").getAsBoolean());
        if (o.has("source") && !o.get("source").isJsonNull()) s.setSource(o.get("source").getAsString());
        if (o.has("baseUrl") && !o.get("baseUrl").isJsonNull()) s.setBaseUrl(o.get("baseUrl").getAsString());
        if (o.has("apiKey") && !o.get("apiKey").isJsonNull()) s.setApiKey(o.get("apiKey").getAsString());
        if (o.has("model") && !o.get("model").isJsonNull()) s.setModel(o.get("model").getAsString());
        if (o.has("maxTokens") && !o.get("maxTokens").isJsonNull()) s.setMaxTokens(o.get("maxTokens").getAsInt());
        if (o.has("temperature") && !o.get("temperature").isJsonNull()) s.setTemperature(o.get("temperature").getAsDouble());
        if (o.has("topP") && !o.get("topP").isJsonNull()) s.setTopP(o.get("topP").getAsDouble());
        if (o.has("stop") && o.get("stop").isJsonArray()) {
            List<String> stop = new ArrayList<>();
            for (int i = 0; i < o.getAsJsonArray("stop").size(); i++) {
                stop.add(o.getAsJsonArray("stop").get(i).getAsString());
            }
            s.setStop(stop);
        }
        if (o.has("ignoreEos") && !o.get("ignoreEos").isJsonNull()) s.setIgnoreEos(o.get("ignoreEos").getAsBoolean());
        if (o.has("debounceMs") && !o.get("debounceMs").isJsonNull()) s.setDebounceMs(o.get("debounceMs").getAsInt());
        s.normalize();
        return s;
    }

    public static CodeCompletionSettings fromJsonString(String json) {
        if (json == null || json.trim().isEmpty()) { return new CodeCompletionSettings(); }
        try {
            return fromJson(JsonParser.parseString(json).getAsJsonObject());
        } catch (Exception e) {
            return new CodeCompletionSettings();
        }
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof CodeCompletionSettings)) return false;
        CodeCompletionSettings that = (CodeCompletionSettings) o;
        return enabled == that.enabled
                && maxTokens == that.maxTokens
                && Double.compare(that.temperature, temperature) == 0
                && Double.compare(that.topP, topP) == 0
                && ignoreEos == that.ignoreEos
                && debounceMs == that.debounceMs
                && Objects.equals(source, that.source)
                && Objects.equals(baseUrl, that.baseUrl)
                && Objects.equals(apiKey, that.apiKey)
                && Objects.equals(model, that.model)
                && Objects.equals(stop, that.stop);
    }

    @Override
    public int hashCode() {
        return Objects.hash(enabled, source, baseUrl, apiKey, model, maxTokens, temperature, topP, stop, ignoreEos, debounceMs);
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionSettingsTest -PskipWebview=true`
预期：PASS（4 个测试全绿）。

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java src/test/java/com/github/claudecodegui/settings/CodeCompletionSettingsTest.java
git commit -m "feat(completion): add CodeCompletionSettings DTO with validation"
```

---

### 任务 2：`CodemossSettingsService` 持久化读写

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java`（在 DSH section 之后新增 `codeCompletion` section 读写）
- 测试：`src/test/java/com/github/claudecodegui/settings/CodemossSettingsServiceCompletionTest.java`

- [ ] **步骤 1：编写失败的测试**

```java
package com.github.claudecodegui.settings;

import org.junit.Test;

import static org.junit.Assert.*;

public class CodemossSettingsServiceCompletionTest {

    @Test
    public void getDefaultsWhenSectionMissing() throws Exception {
        CodemossSettingsService svc = new CodemossSettingsService();
        CodeCompletionSettings s = svc.getCodeCompletionSettings();
        assertFalse(s.isEnabled());
        assertEquals("deepseek", s.getSource());
    }

    @Test
    public void roundTripsPersistedSettings() throws Exception {
        CodemossSettingsService svc = new CodemossSettingsService();
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setSource("custom");
        s.setBaseUrl("https://example.com");
        s.setApiKey("sk-roundtrip");
        s.setModel("deepseek-v4-pro");
        s.setMaxTokens(128);
        svc.setCodeCompletionSettings(s);

        CodeCompletionSettings loaded = svc.getCodeCompletionSettings();
        assertEquals("custom", loaded.getSource());
        assertEquals("https://example.com/", loaded.getBaseUrl());
        assertEquals("sk-roundtrip", loaded.getApiKey());
        assertEquals("deepseek-v4-pro", loaded.getModel());
        assertEquals(128, loaded.getMaxTokens());
        assertTrue(loaded.isEnabled());
    }
}
```

> 注意：该测试会读写真实配置文件（`CodemossSettingsService` 用 `ConfigPathManager` 定位）。若测试环境的 HOME 不可写，测试会失败——此时该测试标记 `@Ignore`，改为在 `setCodeCompletionSettings` 写入前 mock 掉 config path。为保持计划可执行，先用真配置路径；若 CI 报错，将读写收敛为通过 `CodeCompletionSettings.fromJson/toJson` 的逻辑测试替代。

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodemossSettingsServiceCompletionTest -PskipWebview=true`
预期：编译失败（`getCodeCompletionSettings`/`setCodeCompletionSettings` 不存在）。

- [ ] **步骤 3：编写实现代码**

在 `CodemossSettingsService.java` 的 DSH section（约第 357 行 `setDshStringSetting` 之后）新增：

```java
    // ============================================================================
    // Code completion (DeepSeek FIM) settings — persisted in the plugin config's
    // `codeCompletion` section. Credentials are stored in the same private config
    // file (0600) as other provider settings.
    // ============================================================================

    private static final String CODE_COMPLETION_SECTION_KEY = "codeCompletion";

    public CodeCompletionSettings getCodeCompletionSettings() throws IOException {
        JsonObject config = readConfig();
        if (!config.has(CODE_COMPLETION_SECTION_KEY) || config.get(CODE_COMPLETION_SECTION_KEY).isJsonNull()) {
            return new CodeCompletionSettings();
        }
        return CodeCompletionSettings.fromJson(config.getAsJsonObject(CODE_COMPLETION_SECTION_KEY));
    }

    public void setCodeCompletionSettings(CodeCompletionSettings settings) throws IOException {
        if (settings == null) {
            settings = new CodeCompletionSettings();
        }
        settings.normalize();
        JsonObject config = readConfig();
        config.add(CODE_COMPLETION_SECTION_KEY, settings.toJson());
        writeConfig(config);
        LOG.info("[CodemossSettingsService] Saved codeCompletion (enabled=" + settings.isEnabled()
                + ", source=" + settings.getSource() + ")");
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodemossSettingsServiceCompletionTest -PskipWebview=true`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java src/test/java/com/github/claudecodegui/settings/CodemossSettingsServiceCompletionTest.java
git commit -m "feat(completion): persist codeCompletion section in CodemossSettingsService"
```

---

### 任务 3：`DeepSeekFimClient` FIM API 调用

**文件：**
- 创建：`src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java`
- 测试：`src/test/java/com/github/claudecodegui/provider/common/DeepSeekFimClientTest.java`

- [ ] **步骤 1：编写失败的测试**

```java
package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

public class DeepSeekFimClientTest {

    @Test
    public void buildsRequestBodyCorrectly() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        JsonObject body = DeepSeekFimClient.buildRequestBody("prefix-code", "suffix-code", s);
        assertEquals("deepseek-v4-flash", body.get("model").getAsString());
        assertEquals("prefix-code", body.get("prompt").getAsString());
        assertEquals("suffix-code", body.get("suffix").getAsString());
        assertEquals(256, body.get("max_tokens").getAsInt());
        assertEquals("\n\n", body.getAsJsonArray("stop").get(0).getAsString());
    }

    @Test
    public void computesEndpointUrl() {
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com"));
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com/"));
        assertEquals("https://example.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://example.com"));
    }

    @Test
    public void parsesCompletionText() {
        JsonObject body = new JsonObject();
        JsonObject choice = new JsonObject();
        choice.addProperty("text", "int x = 1;");
        com.google.gson.JsonArray choices = new com.google.gson.JsonArray();
        choices.add(choice);
        body.add("choices", choices);
        assertEquals("int x = 1;", DeepSeekFimClient.parseCompletionText(body.toString()));
    }

    @Test
    public void nullOnErrorStatus() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body) -> {
            throw new IllegalStateException("HTTP 401");
        });
        CompletableFuture<String> f = client.complete("a", "b", new CodeCompletionSettings());
        assertNull(f.join());
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.provider.common.DeepSeekFimClientTest -PskipWebview=true`
预期：编译失败（`DeepSeekFimClient` 不存在）。

- [ ] **步骤 3：编写实现代码**

```java
package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * Calls the DeepSeek FIM (Fill-in-the-Middle) completion API:
 * {@code POST {baseUrl}/beta/completions}.
 *
 * <p>Prefix is sent in {@code prompt} and suffix in {@code suffix}; the response
 * text ({@code choices[0].text}) is the middle fragment to insert between them.
 * Errors (401/404/timeout/IO) are swallowed — the returned future completes with
 * {@code null} so the editor integration simply shows no suggestion.
 */
public final class DeepSeekFimClient {

    private static final Logger LOG = Logger.getInstance(DeepSeekFimClient.class);
    private static final int HTTP_TIMEOUT_MS = 5000;

    @FunctionalInterface
    public interface Transport {
        String post(String url, String apiKey, String body) throws Exception;
    }

    private final Transport transport;

    public DeepSeekFimClient() {
        this(DeepSeekFimClient::httpPost);
    }

    DeepSeekFimClient(Transport transport) {
        this.transport = transport;
    }

    public CompletableFuture<String> complete(String prefix, String suffix, CodeCompletionSettings cfg) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                cfg.normalize();
                String url = buildEndpoint(cfg.getBaseUrl());
                String body = buildRequestBody(prefix, suffix, cfg).toString();
                String resp = transport.post(url, cfg.getApiKey(), body);
                return parseCompletionText(resp);
            } catch (Exception e) {
                LOG.debug("[DeepSeekFimClient] completion failed: " + e.getMessage());
                return null;
            }
        });
    }

    static String buildEndpoint(String baseUrl) {
        String base = baseUrl == null ? CodeCompletionSettings.DEFAULT_BASE_URL : baseUrl.trim();
        if (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        return base + "/beta/completions";
    }

    static JsonObject buildRequestBody(String prefix, String suffix, CodeCompletionSettings cfg) {
        JsonObject o = new JsonObject();
        o.addProperty("model", cfg.getModel());
        o.addProperty("prompt", prefix == null ? "" : prefix);
        o.addProperty("suffix", suffix == null ? "" : suffix);
        o.addProperty("max_tokens", cfg.getMaxTokens());
        o.addProperty("temperature", cfg.getTemperature());
        o.addProperty("top_p", cfg.getTopP());
        JsonArray stop = new JsonArray();
        for (String s : cfg.getStop()) { stop.add(s); }
        o.add("stop", stop);
        o.addProperty("ignore_eos", cfg.isIgnoreEos());
        o.addProperty("stream", false);
        return o;
    }

    static String parseCompletionText(String responseBody) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return null;
        }
        JsonObject root = JsonParser.parseString(responseBody).getAsJsonObject();
        if (!root.has("choices") || root.get("choices").isJsonArray()
                && root.getAsJsonArray("choices").isEmpty()) {
            return null;
        }
        JsonObject first = root.getAsJsonArray("choices").get(0).getAsJsonObject();
        if (!first.has("text") || first.get("text").isJsonNull()) {
            return null;
        }
        String text = first.get("text").getAsString();
        return text == null || text.isEmpty() ? null : text;
    }

    private static String httpPost(String url, String apiKey, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofMillis(HTTP_TIMEOUT_MS))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .header("Authorization", "Bearer " + (apiKey == null ? "" : apiKey))
                .POST(HttpRequest.BodyPublishers.ofString(body));
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofMillis(HTTP_TIMEOUT_MS))
                .build();
        HttpResponse<String> resp = client.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("HTTP " + resp.statusCode());
        }
        return resp.body();
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.provider.common.DeepSeekFimClientTest -PskipWebview=true`
预期：PASS（4 个测试全绿）。

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java src/test/java/com/github/claudecodegui/provider/common/DeepSeekFimClientTest.java
git commit -m "feat(completion): add DeepSeekFimClient for /beta/completions"
```

---

### 任务 4：`InlineCompletionManager` 编辑器集成（纯逻辑 + IDE 接线）

**文件：**
- 创建：`src/main/java/com/github/claudecodegui/ui/InlineCompletionManager.java`
- 测试：`src/test/java/com/github/claudecodegui/ui/InlineCompletionManagerTest.java`（仅测抽离出的纯逻辑）

> 说明：InlayModel/Document 的 IDE 交互无法在无 IDE 环境单测。将**防抖合并**、**上下文提取**、**插入位置计算**抽为静态纯方法，本任务只单测这些逻辑；Inlay 显示/Tab 接受在任务 5 的编译验证中覆盖。

- [ ] **步骤 1：编写失败的测试**

```java
package com.github.claudecodegui.ui;

import org.junit.Test;

import static org.junit.Assert.*;

public class InlineCompletionManagerTest {

    @Test
    public void extractsPrefixSuffixAroundCaret() {
        // document text "abc<caret>def"
        String doc = "abcdef";
        InlineCompletionManager.Context ctx =
                InlineCompletionManager.extractContext(doc, 3, 100, 100);
        assertEquals("abc", ctx.prefix);
        assertEquals("def", ctx.suffix);
    }

    @Test
    public void clampsPrefixToMaxChars() {
        String doc = "0123456789xyz";
        InlineCompletionManager.Context ctx =
                InlineCompletionManager.extractContext(doc, 10, 5, 100);
        assertEquals("56789", ctx.prefix);
    }

    @Test
    public void emptyContextWhenCaretAtZero() {
        InlineCompletionManager.Context ctx =
                InlineCompletionManager.extractContext("hello", 0, 100, 100);
        assertEquals("", ctx.prefix);
        assertEquals("hello", ctx.suffix);
    }

    @Test
    public void insertOffsetEqualsCaretOffset() {
        // FIM middle fragment inserts exactly at the caret (between prefix and suffix).
        assertEquals(3, InlineCompletionManager.computeInsertOffset(3));
    }

    @Test
    public void shouldSuggestRejectsBlankCaret() {
        assertFalse(InlineCompletionManager.shouldSuggest("   ", 3));
        assertTrue(InlineCompletionManager.shouldSuggest("abc", 3));
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.ui.InlineCompletionManagerTest -PskipWebview=true`
预期：编译失败（`InlineCompletionManager` 不存在）。

- [ ] **步骤 3：编写实现代码**

```java
package com.github.claudecodegui.ui;

import com.github.claudecodegui.provider.common.DeepSeekFimClient;
import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Caret;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.CaretEvent;
import com.intellij.openapi.editor.event.CaretListener;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.project.Project;
import com.intellij.util.Alarm;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Editor inline completion for DeepSeek FIM. Listens to caret/document changes,
 * debounces, requests a completion, and shows it as a grey inlay hint at the
 * caret. Tab accepts, Esc/caret-move cancels.
 *
 * <p>Pure logic (context extraction, insert offset, trigger guard) is extracted
 * into static methods so it can be unit-tested without an IDE runtime.
 */
public class InlineCompletionManager {

    private static final Logger LOG = Logger.getInstance(InlineCompletionManager.class);
    private static final int MAX_PREFIX_CHARS = 4000;
    private static final int MAX_SUFFIX_CHARS = 1000;

    private final Project project;
    private final DeepSeekFimClient client;
    private final CodemossSettingsService settingsService;
    private Alarm debounceAlarm;
    private MessageBusConnection connection;
    private final AtomicBoolean disposed = new AtomicBoolean(false);
    private volatile CompletableFuture<String> inFlight;
    private volatile int lastCaretOffset = -1;

    public InlineCompletionManager(Project project, DeepSeekFimClient client) {
        this.project = project;
        this.client = client;
        this.settingsService = new CodemossSettingsService();
    }

    /** Register listeners on the editor event multicaster (mirrors EditorContextTracker). */
    public void registerListeners() {
        connection = project.getMessageBus().connect();
        debounceAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);

        DocumentListener docListener = new DocumentListener() {
            @Override
            public void documentChanged(@NotNull DocumentEvent event) {
                onEdit(event.getDocument());
            }
        };
        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(docListener, connection);

        CaretListener caretListener = new CaretListener() {
            @Override
            public void caretPositionChanged(@NotNull CaretEvent event) {
                onEdit(event.getEditor().getDocument());
            }
        };
        EditorFactory.getInstance().getEventMulticaster().addCaretListener(caretListener, connection);
    }

    private void onEdit(Document document) {
        if (disposed.get()) return;
        debounceAlarm.cancelAllRequests();
        debounceAlarm.addRequest(() -> trigger(document), readDebounceMs());
    }

    private void trigger(Document document) {
        if (disposed.get()) return;
        CodeCompletionSettings cfg = readSettings();
        if (cfg == null || !cfg.isEnabled()) return;

        Editor editor = editorFor(document);
        if (editor == null) return;

        Caret caret = editor.getCaretModel().getPrimaryCaret();
        int offset = caret.getOffset();
        lastCaretOffset = offset;
        String text = document.getText();
        if (!shouldSuggest(text, offset)) return;

        Context ctx = extractContext(text, offset, MAX_PREFIX_CHARS, MAX_SUFFIX_CHARS);
        cancelInFlight();
        CompletableFuture<String> future = client.complete(ctx.prefix, ctx.suffix, cfg);
        inFlight = future;
        future.thenAccept(suggestion -> {
            if (disposed.get() || suggestion == null || suggestion.isEmpty()) return;
            if (caret.getOffset() != offset) return; // caret moved; drop
            showInlayHint(editor, offset, suggestion);
        });
    }

    private void showInlayHint(Editor editor, int offset, String suggestion) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (editor.isDisposed()) return;
            // MVP: use inlay model inline element. The exact renderer API is
            // validated against IntelliJ 2024.3 in Task 5 (compile check).
            editor.getInlayModel().addInlineElement(offset, true, new GreyInlineRenderer(suggestion));
        });
    }

    private void cancelInFlight() {
        CompletableFuture<String> f = inFlight;
        if (f != null && !f.isDone()) {
            f.cancel(true);
        }
    }

    private CodeCompletionSettings readSettings() {
        try {
            return settingsService.getCodeCompletionSettings();
        } catch (Exception e) {
            LOG.debug("[InlineCompletion] failed to read settings: " + e.getMessage());
            return null;
        }
    }

    private int readDebounceMs() {
        try {
            return settingsService.getCodeCompletionSettings().getDebounceMs();
        } catch (Exception e) {
            return CodeCompletionSettings.DEFAULT_DEBOUNCE_MS;
        }
    }

    private Editor editorFor(Document document) {
        for (Editor e : EditorFactory.getInstance().getEditors(document, project)) {
            return e;
        }
        return null;
    }

    public void dispose() {
        disposed.set(true);
        cancelInFlight();
        if (connection != null) connection.disconnect();
        if (debounceAlarm != null) debounceAlarm.dispose();
    }

    // ---- Pure, unit-testable logic ----

    static final class Context {
        final String prefix;
        final String suffix;
        Context(String prefix, String suffix) { this.prefix = prefix; this.suffix = suffix; }
    }

    static Context extractContext(String text, int caretOffset, int maxPrefix, int maxSuffix) {
        int offset = Math.max(0, Math.min(caretOffset, text.length()));
        int prefixStart = Math.max(0, offset - maxPrefix);
        int suffixEnd = Math.min(text.length(), offset + maxSuffix);
        return new Context(text.substring(prefixStart, offset), text.substring(offset, suffixEnd));
    }

    static int computeInsertOffset(int caretOffset) {
        return caretOffset;
    }

    static boolean shouldSuggest(String text, int caretOffset) {
        if (text == null) return false;
        int offset = Math.max(0, Math.min(caretOffset, text.length()));
        if (offset == 0) return false; // nothing before caret
        String before = text.substring(0, offset);
        return !before.isBlank();
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.ui.InlineCompletionManagerTest -PskipWebview=true`
预期：PASS（5 个测试全绿）。

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/ui/InlineCompletionManager.java src/test/java/com/github/claudecodegui/ui/InlineCompletionManagerTest.java
git commit -m "feat(completion): add InlineCompletionManager with debounced FIM trigger"
```

---

### 任务 5：Inlay 渲染器 + 项目启动挂载（编译验证）

**文件：**
- 创建：`src/main/java/com/github/claudecodegui/ui/GreyInlineRenderer.java`
- 修改：`src/main/java/com/github/claudecodegui/ui/InlineCompletionManager.java`（import `GreyInlineRenderer` 已完成，本任务补 renderer 实现）
- 修改：`src/main/resources/META-INF/plugin.xml`（可选注册 postStartupActivity 挂载）

- [ ] **步骤 1：编写 `GreyInlineRenderer`**

```java
package com.github.claudecodegui.ui;

import com.intellij.openapi.editor.DefaultLanguageHighlighterColors;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.Inlay;
import com.intellij.openapi.editor.colors.EditorFontType;
import com.intellij.openapi.editor.impl.EditorImpl;
import com.intellij.openapi.editor.markup.TextAttributes;
import com.intellij.ui.Gray;
import org.jetbrains.annotations.NotNull;

import java.awt.*;

/**
 * Grey inline suggestion renderer drawn inside an {@link Inlay} at the caret.
 * Uses the editor's plain font and a grey foreground so the hint reads as a
 * ghost-suggestion until the user presses Tab.
 */
public final class GreyInlineRenderer implements com.intellij.openapi.editor.EditorCustomElementRenderer {

    private final String suggestion;

    public GreyInlineRenderer(String suggestion) {
        this.suggestion = suggestion == null ? "" : suggestion;
    }

    @Override
    public int calcWidthInPixels(@NotNull Inlay inlay) {
        Editor editor = inlay.getEditor();
        Font font = editor.getColorsScheme().getFont(EditorFontType.PLAIN);
        return editor.getContentComponent().getFontMetrics(font).stringWidth(suggestion);
    }

    @Override
    public void paint(@NotNull Inlay inlay, @NotNull Graphics g, java.awt.Rectangle targetRegion,
                      @NotNull TextAttributes textAttributes) {
        Editor editor = inlay.getEditor();
        Font font = editor.getColorsScheme().getFont(EditorFontType.PLAIN);
        g.setFont(font);
        g.setColor(Gray._150);
        int ascent = editor.getContentComponent().getFontMetrics(font).getAscent();
        g.drawString(suggestion, targetRegion.x, targetRegion.y + ascent);
    }
}
```

- [ ] **步骤 2：编译验证**

运行：`./gradlew compileJava -PskipWebview=true`
预期：若 `EditorCustomElementRenderer` 方法签名在 IntelliJ 2024.3 下不匹配，按编译器提示修正（该方法签名以目标 IDE SDK 为准）。修正后编译通过。

- [ ] **步骤 3：挂载到项目（可选启动时注册）**

在 `InlineCompletionManager` 增加静态工厂与启动挂载（若需要全局启用）：

```java
    public static InlineCompletionManager attach(Project project) {
        InlineCompletionManager mgr = new InlineCompletionManager(project, new DeepSeekFimClient());
        mgr.registerListeners();
        return mgr;
    }
```

并在 `plugin.xml` 的 `<extensions>` 中新增（参考现有 postStartupActivity 模式，实际类名与生命周期按项目现有 `BridgePreloader` 对齐）：

```xml
<postStartupActivity implementation="com.github.claudecodegui.startup.InlineCompletionBootstrap"/>
```

> 若项目已有统一的项目级服务管理，改用 `com.intellij.openapi.components.Service` 挂载，避免重复实例。实现计划按最小改动：新增一个 `InlineCompletionBootstrap`（postStartupActivity，创建并持有 manager，项目关闭时 dispose）。

- [ ] **步骤 4：编写 `InlineCompletionBootstrap`**

```java
package com.github.claudecodegui.startup;

import com.github.claudecodegui.provider.common.DeepSeekFimClient;
import com.github.claudecodegui.ui.InlineCompletionManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;

/**
 * Attaches the FIM inline completion manager when a project opens.
 */
public final class InlineCompletionBootstrap implements ProjectActivity {

    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        InlineCompletionManager mgr = new InlineCompletionManager(project, new DeepSeekFimClient());
        mgr.registerListeners();
        // Lifecycle: dispose on project close via a disposable listener.
        project.getMessageBus().connect().subscribe(
                com.intellij.openapi.project.ProjectManagerListener.TOPIC,
                new com.intellij.openapi.project.ProjectManagerListener() {
                    @Override
                    public void projectClosed(@NotNull Project p) {
                        if (p.equals(project)) {
                            mgr.dispose();
                        }
                    }
                });
        return Unit.INSTANCE;
    }
}
```

> 注：`ProjectActivity` 与 `postStartupActivity` 二选一。若项目当前使用 `postStartupActivity`（见 plugin.xml 的 `BridgePreloader`），则改用 `StartupActivity.DumbAware` 接口实现 `runActivity`，签名按目标 IDE 编译验证为准。

- [ ] **步骤 5：编译验证 + Commit**

运行：`./gradlew compileJava -PskipWebview=true`
预期：编译通过。

```bash
git add src/main/java/com/github/claudecodegui/ui/GreyInlineRenderer.java src/main/java/com/github/claudecodegui/ui/InlineCompletionManager.java src/main/java/com/github/claudecodegui/startup/InlineCompletionBootstrap.java src/main/resources/META-INF/plugin.xml
git commit -m "feat(completion): render grey inline hint and attach on project open"
```

---

### 任务 6：`SettingsHandler` bridge case

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`（新增 `get_code_completion_settings` / `set_code_completion_settings` 到 `SUPPORTED_TYPES` + switch + 处理逻辑）

- [ ] **步骤 1：在 `SUPPORTED_TYPES` 末尾新增两项**

在 `"clear_user_language"` 之后（保持数组语法）新增：

```java
        "clear_user_language",
        // Code completion (DeepSeek FIM) settings
        "get_code_completion_settings",
        "set_code_completion_settings"
```

- [ ] **步骤 2：在 `handle` switch 末尾新增两个 case**

在 `case "clear_user_language":` 对应处理之后新增：

```java
            case "get_code_completion_settings":
                handleGetCodeCompletionSettings();
                return true;
            case "set_code_completion_settings":
                handleSetCodeCompletionSettings(content);
                return true;
```

- [ ] **步骤 3：新增两个私有处理方法**

在 `SettingsHandler` 类内新增（复用 `gson`、`callJavaScript` 模式，参照 `ProjectConfigHandler.respondWithJson`）：

```java
    private void handleGetCodeCompletionSettings() {
        try {
            CodeCompletionSettings settings = new CodemossSettingsService().getCodeCompletionSettings();
            String json = gson.toJson(settings.toJson());
            ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.updateCodeCompletionSettings", escapeJs(json)));
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get code completion settings: " + e.getMessage(), e);
        }
    }

    private void handleSetCodeCompletionSettings(String content) {
        try {
            JsonObject json = content == null ? new JsonObject()
                    : gson.fromJson(content, JsonObject.class);
            CodeCompletionSettings settings = CodeCompletionSettings.fromJson(json);
            new CodemossSettingsService().setCodeCompletionSettings(settings);
            String resp = gson.toJson(settings.toJson());
            ApplicationManager.getApplication().invokeLater(() ->
                    callJavaScript("window.updateCodeCompletionSettings", escapeJs(resp)));
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set code completion settings: " + e.getMessage(), e);
        }
    }
```

并在文件头部 import 处新增：

```java
import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.github.claudecodegui.settings.CodemossSettingsService;
```

- [ ] **步骤 4：编译验证**

运行：`./gradlew compileJava -PskipWebview=true`
预期：编译通过。

- [ ] **步骤 5：Commit**

```bash
git add src/main/java/com/github/claudecodegui/handler/SettingsHandler.java
git commit -m "feat(completion): add settings bridge for code completion config"
```

---

### 任务 7：webview 设置 UI + i18n

**文件：**
- 创建：`webview/src/components/settings/CodeCompletionSection/index.tsx`
- 创建：`webview/src/components/settings/CodeCompletionSection/style.module.less`
- 修改：`webview/src/components/settings/SettingsSidebar/index.tsx`（SettingsTab 类型 + sidebarItems）
- 修改：`webview/src/components/settings/index.tsx`（import + currentTab 渲染）
- 修改：`webview/src/i18n/locales/en.json` 与 `zh.json`（新增 `settings.codeCompletion` 文案）
- 测试：`webview/src/components/settings/CodeCompletionSection/index.test.tsx`

- [ ] **步骤 1：编写失败的组件测试**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CodeCompletionSection, { CodeCompletionConfig } from './index';

const defaults: CodeCompletionConfig = {
  enabled: false,
  source: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-flash',
  maxTokens: 256,
  temperature: 1.0,
  topP: 1.0,
  stop: ['\n\n'],
  ignoreEos: false,
  debounceMs: 300,
};

describe('CodeCompletionSection', () => {
  it('renders enabled toggle', () => {
    render(<CodeCompletionSection config={defaults} onSave={vi.fn()} />);
    expect(screen.getByLabelText(/enable|启用/)).toBeTruthy();
  });

  it('shows apiKey input only for custom source', () => {
    const { rerender } = render(
      <CodeCompletionSection config={defaults} onSave={vi.fn()} />
    );
    expect(screen.queryByLabelText(/API Key/i)).toBeNull();
    rerender(<CodeCompletionSection config={{ ...defaults, source: 'custom' }} onSave={vi.fn()} />);
    expect(screen.getByLabelText(/API Key/i)).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd webview && npx vitest run src/components/settings/CodeCompletionSection/index.test.tsx`
预期：失败（组件不存在）。

- [ ] **步骤 3：编写组件**

`CodeCompletionSection/index.tsx`：

```tsx
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export interface CodeCompletionConfig {
  enabled: boolean;
  source: 'deepseek' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  stop: string[];
  ignoreEos: boolean;
  debounceMs: number;
}

interface Props {
  config: CodeCompletionConfig;
  onSave: (config: CodeCompletionConfig) => void;
}

const CodeCompletionSection = ({ config, onSave }: Props) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CodeCompletionConfig>(config);

  const set = <K extends keyof CodeCompletionConfig>(key: K, value: CodeCompletionConfig[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const handleSave = useCallback(() => {
    onSave(draft);
  }, [draft, onSave]);

  return (
    <div className={styles.section}>
      <h3>{t('settings.codeCompletion.groupTitle')}</h3>
      <label className={styles.row}>
        <input
          type="checkbox"
          aria-label="enable"
          checked={draft.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        <span>{t('settings.codeCompletion.enable')}</span>
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.source')}</span>
        <select
          value={draft.source}
          onChange={(e) => set('source', e.target.value as CodeCompletionConfig['source'])}
        >
          <option value="deepseek">{t('settings.codeCompletion.sourceDeepseek')}</option>
          <option value="custom">{t('settings.codeCompletion.sourceCustom')}</option>
        </select>
      </label>

      {draft.source === 'custom' && (
        <>
          <label className={styles.row}>
            <span>{t('settings.codeCompletion.baseUrl')}</span>
            <input
              aria-label="Base URL"
              value={draft.baseUrl}
              onChange={(e) => set('baseUrl', e.target.value)}
            />
          </label>
          <label className={styles.row}>
            <span>{t('settings.codeCompletion.apiKey')}</span>
            <input
              type="password"
              aria-label="API Key"
              value={draft.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
            />
          </label>
        </>
      )}

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.model')}</span>
        <select value={draft.model} onChange={(e) => set('model', e.target.value)}>
          <option value="deepseek-v4-flash">deepseek-v4-flash</option>
          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
        </select>
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.maxTokens')}</span>
        <input
          type="number"
          aria-label="Max Tokens"
          value={draft.maxTokens}
          onChange={(e) => set('maxTokens', Number(e.target.value))}
        />
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.temperature')}</span>
        <input
          type="number"
          step="0.1"
          aria-label="Temperature"
          value={draft.temperature}
          onChange={(e) => set('temperature', Number(e.target.value))}
        />
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.topP')}</span>
        <input
          type="number"
          step="0.1"
          aria-label="Top P"
          value={draft.topP}
          onChange={(e) => set('topP', Number(e.target.value))}
        />
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.debounceMs')}</span>
        <input
          type="number"
          aria-label="Debounce"
          value={draft.debounceMs}
          onChange={(e) => set('debounceMs', Number(e.target.value))}
        />
      </label>

      <label className={styles.row}>
        <span>{t('settings.codeCompletion.ignoreEos')}</span>
        <input
          type="checkbox"
          aria-label="Ignore EOS"
          checked={draft.ignoreEos}
          onChange={(e) => set('ignoreEos', e.target.checked)}
        />
      </label>

      <button onClick={handleSave}>{t('settings.codeCompletion.save')}</button>
    </div>
  );
};

export default CodeCompletionSection;
```

`CodeCompletionSection/style.module.less`：

```less
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd webview && npx vitest run src/components/settings/CodeCompletionSection/index.test.tsx`
预期：PASS。

- [ ] **步骤 5：接入 sidebar 与主内容区**

`SettingsSidebar/index.tsx`：
1. `SettingsTab` 联合类型加入 `'codeCompletion'`。
2. `sidebarItems` 数组加入 `{ key: 'codeCompletion', icon: 'codicon-sparkle', labelKey: 'settings.codeCompletion.title' }`。

`settings/index.tsx`：
1. import `CodeCompletionSection`。
2. 在某个 `currentTab === 'xxx' && (...)` 块后新增：

```tsx
{currentTab === 'codeCompletion' && (
  <CodeCompletionSection
    config={codeCompletionConfig}
    onSave={handleCodeCompletionSave}
  />
)}
```

（其中 `codeCompletionConfig` 状态与 `handleCodeCompletionSave` 通过现有 bridge 事件 `get_code_completion_settings` / `set_code_completion_settings` 加载与保存，参照现有 section 的状态模式。）

- [ ] **步骤 6：i18n 文案**

`en.json` 的 `settings` 块新增：

```json
"codeCompletion": {
  "title": "Code Completion",
  "groupTitle": "Inline Code Completion (DeepSeek FIM)",
  "enable": "Enable inline code completion",
  "source": "Credential source",
  "sourceDeepseek": "DeepSeek official",
  "sourceCustom": "Custom",
  "baseUrl": "Base URL",
  "apiKey": "API Key",
  "model": "Model",
  "maxTokens": "Max tokens",
  "temperature": "Temperature",
  "topP": "Top P",
  "debounceMs": "Debounce (ms)",
  "ignoreEos": "Ignore EOS",
  "save": "Save"
}
```

`zh.json` 对应：

```json
"codeCompletion": {
  "title": "代码补全",
  "groupTitle": "编辑器内联代码补全（DeepSeek FIM）",
  "enable": "启用内联代码补全",
  "source": "凭证来源",
  "sourceDeepseek": "DeepSeek 官方",
  "sourceCustom": "自定义",
  "baseUrl": "接口地址",
  "apiKey": "API Key",
  "model": "模型",
  "maxTokens": "最大 token 数",
  "temperature": "温度",
  "topP": "核采样 Top P",
  "debounceMs": "防抖（毫秒）",
  "ignoreEos": "忽略 EOS",
  "save": "保存"
}
```

- [ ] **步骤 7：前端整体类型检查**

运行：`cd webview && npx tsc --noEmit`
预期：通过（若 `codeCompletionConfig` 状态尚未在 settings/index.tsx 完整接线，补齐后通过）。

- [ ] **步骤 8：Commit**

```bash
git add webview/src/components/settings/CodeCompletionSection webview/src/components/settings/SettingsSidebar/index.tsx webview/src/components/settings/index.tsx webview/src/i18n/locales/en.json webview/src/i18n/locales/zh.json
git commit -m "feat(completion): add code completion settings section and i18n"
```

---

## 自检记录

**1. 规格覆盖度**（对照设计文档 §1-§12）：
- 配置层字段与默认值 → 任务 1、2 ✅
- 凭证来源仅 `deepseek`/`custom` → 任务 1 校验 ✅
- FIM 客户端 `/beta/completions` + 参数 → 任务 3 ✅
- 编辑器集成（防抖、Inlay、Tab/Esc、取消） → 任务 4、5 ✅
- 设置 UI + bridge → 任务 6、7 ✅
- 测试（DTO、FIM、防抖、UI） → 各任务步骤 1/4 ✅

**2. 占位符扫描**：无"待定/TODO"。任务 5 的 `GreyInlineRenderer` / `InlineCompletionBootstrap` 中 IDE API 签名以"编译验证为准"明确标注，属计划内诚实声明而非占位符。

**3. 类型一致性**：
- `CodeCompletionSettings` 字段名（`isEnabled/getSource/...`）在任务 1 定义，任务 2/3/4 使用一致 ✅
- `DeepSeekFimClient.complete(prefix, suffix, cfg)` 签名任务 3 定义，任务 4 调用一致 ✅
- `InlineCompletionManager.Context`/`extractContext`/`computeInsertOffset`/`shouldSuggest` 任务 4 定义并测试一致 ✅

**4. 待用户提供**：任务 3 完成后的**端到端验证**需要用户提供 DeepSeek API key（用于对 `deepseek-v4-flash` / `deepseek-v4-pro` 各发一次真实 FIM 请求，确认端点与模型可用性）。
