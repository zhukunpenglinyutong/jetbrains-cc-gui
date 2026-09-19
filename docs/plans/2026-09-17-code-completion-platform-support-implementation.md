# 代码补全平台支持 + 测试连接 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让内联补全支持多个真实具备 FIM 能力的平台（DeepSeek 官方、SiliconFlow、任意 OpenAI 兼容 `/completions`），并提供「测试连接」让配置错误可见。

**架构：** 沿用 v1 的 `FimCompletionContributor`（编辑器侧）与 OpenAI 兼容 completions 协议；把硬编码的 `/beta/completions` 改为可配置 `path`；新增 host 匹配的凭证复用解析器；新增 bridge `test_code_completion` 做真实调用并回显状态。平台预置表只存在于 webview（UI 数据），Java 侧只存已解析的最终值 + 迁移推导。

**技术栈：** Java 17、IntelliJ Platform 2024.3.1（IC）、`java.net.http.HttpClient`、Gson、JUnit 4；React 19 + TS + Vite、Vitest。

**设计文档：** `docs/plans/2026-09-17-code-completion-platform-support-design.md`

**执行环境注意事项：**
- 本仓库有全局 `pre-commit` 钩子需人工确认，且当前环境无法运行其 bash。**所有 commit 步骤由用户手动执行**（计划中标注为「人工」）。
- 后端测试统一加 `-PskipWebview=true` 跳过 webview 构建以提速。
- `JAVA_HOME` 需指向 JDK 17（本机为 `D:\Program Files\Java\jdk-17.0.2`，`PATH` 默认的 `java` 是 8）。

---

### 任务 1：`CodeCompletionSettings` 增加 preset / path 与迁移

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java`（整文件替换）
- 测试：`src/test/java/com/github/claudecodegui/settings/CodeCompletionSettingsTest.java`

- [ ] **步骤 1：编写失败的测试**

在 `CodeCompletionSettingsTest` 中新增（保留原有 8 个用例；把原来引用 `setSource/getSource` 的用例改为 `setPreset/getPreset`）：

```java
    @Test
    public void defaultsIncludePresetAndPath() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
        assertEquals("deepseek-flash", s.getModel());
    }

    @Test
    public void invalidPresetFallsBackToDeepseek() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPreset("bogus");
        s.normalize();
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
    }

    @Test
    public void migratesLegacySourceKeyToPreset() {
        JsonObject legacy = new JsonObject();
        legacy.addProperty("source", "custom");
        legacy.addProperty("baseUrl", "https://api.siliconflow.cn");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(legacy);
        assertEquals(CodeCompletionSettings.PRESET_CUSTOM, s.getPreset());
        assertEquals(CodeCompletionSettings.DEFAULT_PATH, s.getPath());
    }

    @Test
    public void derivesDeepseekPathFromHostEvenWhenPresetIsCustom() {
        // 回归：现存配置 source=custom + baseUrl=https://api.deepseek.com/ 打的是官方
        // /beta/completions，不能因为 preset=custom 就推到 /v1/completions。
        JsonObject legacy = new JsonObject();
        legacy.addProperty("source", "custom");
        legacy.addProperty("baseUrl", "https://api.deepseek.com/");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(legacy);
        assertEquals("/beta/completions", s.getPath());
    }

    @Test
    public void keepsExplicitPath() {
        JsonObject o = new JsonObject();
        o.addProperty("baseUrl", "https://example.com");
        o.addProperty("path", "completions");
        CodeCompletionSettings s = CodeCompletionSettings.fromJson(o);
        assertEquals("/completions", s.getPath());
    }

    @Test
    public void rejectsAbsoluteUrlAsPath() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPath("https://evil.example.com/v1/completions");
        s.normalize();
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
    }

    @Test
    public void roundTripsPresetAndPath() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setPreset(CodeCompletionSettings.PRESET_SILICONFLOW);
        s.setBaseUrl("https://api.siliconflow.cn");
        s.setPath("/v1/completions");
        s.setModel("deepseek-ai/DeepSeek-V3");
        s.setApiKey("sk-x");
        s.normalize();
        CodeCompletionSettings copy = CodeCompletionSettings.fromJson(s.toJson());
        assertEquals(s, copy);
    }
```

需要 `import com.google.gson.JsonObject;`。

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionSettingsTest -PskipWebview=true`
预期：编译失败（`getPreset`/`setPreset`/`getPath`/`PRESET_DEEPSEEK`/`DEEPSEEK_PATH`/`DEFAULT_PATH` 不存在）。

- [ ] **步骤 3：整文件替换 `CodeCompletionSettings.java`**

```java
package com.github.claudecodegui.settings;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * Pure DTO for the code-completion (FIM) configuration.
 *
 * <p>Speaks the OpenAI-compatible completions shape ({@code prompt} + {@code suffix}
 * → {@code choices[0].text}); the only per-platform difference we model is
 * {@code baseUrl} + {@code path}. Persistence lives in
 * {@link CodemossSettingsService}.
 */
public final class CodeCompletionSettings {

    public static final String PRESET_DEEPSEEK = "deepseek";
    public static final String PRESET_SILICONFLOW = "siliconflow";
    public static final String PRESET_CUSTOM = "custom";

    public static final String DEFAULT_PRESET = PRESET_DEEPSEEK;
    public static final String DEFAULT_BASE_URL = "https://api.deepseek.com";
    /** Path used by every OpenAI-compatible gateway. */
    public static final String DEFAULT_PATH = "/v1/completions";
    /** DeepSeek's FIM endpoint lives under /beta. */
    public static final String DEEPSEEK_PATH = "/beta/completions";
    public static final String DEEPSEEK_HOST = "api.deepseek.com";

    public static final String DEFAULT_MODEL = "deepseek-flash";
    public static final int DEFAULT_MAX_TOKENS = 256;
    public static final double DEFAULT_TEMPERATURE = 1.0;
    public static final double DEFAULT_TOP_P = 1.0;
    public static final int DEFAULT_DEBOUNCE_MS = 300;
    public static final List<String> DEFAULT_STOP = Arrays.asList("\n\n");

    private boolean enabled = false;
    private String preset = DEFAULT_PRESET;
    private String baseUrl = DEFAULT_BASE_URL;
    private String path = DEEPSEEK_PATH;
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

    public String getPreset() { return preset; }
    public void setPreset(String preset) { this.preset = preset == null ? "" : preset.trim(); }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl == null ? "" : baseUrl.trim(); }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path == null ? "" : path.trim(); }

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

    /** The path to use when the config does not carry one. */
    public static String defaultPathFor(String baseUrl, String preset) {
        if (PRESET_DEEPSEEK.equals(preset) || DEEPSEEK_HOST.equalsIgnoreCase(hostOf(baseUrl))) {
            return DEEPSEEK_PATH;
        }
        return DEFAULT_PATH;
    }

    /** Host of a URL, or "" when it cannot be parsed. Never throws. */
    public static String hostOf(String url) {
        if (url == null || url.trim().isEmpty()) {
            return "";
        }
        try {
            String host = URI.create(url.trim()).getHost();
            return host == null ? "" : host;
        } catch (Exception e) {
            return "";
        }
    }

    /** Apply validation: invalid values fall back to defaults. */
    public void normalize() {
        if (!PRESET_DEEPSEEK.equals(preset) && !PRESET_SILICONFLOW.equals(preset) && !PRESET_CUSTOM.equals(preset)) {
            preset = DEFAULT_PRESET;
        }
        if (baseUrl == null || baseUrl.isEmpty()) {
            baseUrl = DEFAULT_BASE_URL;
        }
        while (baseUrl.endsWith("/")) {
            baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        }
        // A path must be a relative endpoint path — never an absolute URL.
        boolean absolute = path == null || path.isEmpty() || path.startsWith("http://") || path.startsWith("https://");
        if (absolute) {
            path = defaultPathFor(baseUrl, preset);
        } else if (!path.startsWith("/")) {
            path = "/" + path;
        }
        while (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        if (model == null || model.isEmpty()) {
            model = DEFAULT_MODEL;
        }
        if (maxTokens < 1 || maxTokens > 8192) {
            maxTokens = DEFAULT_MAX_TOKENS;
        }
        if (temperature < 0 || temperature > 2) {
            temperature = DEFAULT_TEMPERATURE;
        }
        if (topP <= 0 || topP > 1) {
            topP = DEFAULT_TOP_P;
        }
        if (debounceMs < 0 || debounceMs > 5000) {
            debounceMs = DEFAULT_DEBOUNCE_MS;
        }
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("enabled", enabled);
        o.addProperty("preset", preset);
        o.addProperty("baseUrl", baseUrl);
        o.addProperty("path", path);
        o.addProperty("apiKey", apiKey);
        o.addProperty("model", model);
        o.addProperty("maxTokens", maxTokens);
        o.addProperty("temperature", temperature);
        o.addProperty("topP", topP);
        JsonArray stopArr = new JsonArray();
        for (String s : stop) {
            stopArr.add(s);
        }
        o.add("stop", stopArr);
        o.addProperty("ignoreEos", ignoreEos);
        o.addProperty("debounceMs", debounceMs);
        return o;
    }

    public static CodeCompletionSettings fromJson(JsonObject o) {
        CodeCompletionSettings s = new CodeCompletionSettings();
        if (o == null) {
            return s;
        }
        if (o.has("enabled") && !o.get("enabled").isJsonNull()) {
            s.setEnabled(o.get("enabled").getAsBoolean());
        }
        // Migration: v1 stored "source" instead of "preset".
        if (o.has("preset") && !o.get("preset").isJsonNull()) {
            s.setPreset(o.get("preset").getAsString());
        } else if (o.has("source") && !o.get("source").isJsonNull()) {
            s.setPreset(o.get("source").getAsString());
        }
        if (o.has("baseUrl") && !o.get("baseUrl").isJsonNull()) {
            s.setBaseUrl(o.get("baseUrl").getAsString());
        }
        if (o.has("path") && !o.get("path").isJsonNull()) {
            s.setPath(o.get("path").getAsString());
        } else {
            s.setPath("");
        }
        if (o.has("apiKey") && !o.get("apiKey").isJsonNull()) {
            s.setApiKey(o.get("apiKey").getAsString());
        }
        if (o.has("model") && !o.get("model").isJsonNull()) {
            s.setModel(o.get("model").getAsString());
        }
        if (o.has("maxTokens") && !o.get("maxTokens").isJsonNull()) {
            s.setMaxTokens(o.get("maxTokens").getAsInt());
        }
        if (o.has("temperature") && !o.get("temperature").isJsonNull()) {
            s.setTemperature(o.get("temperature").getAsDouble());
        }
        if (o.has("topP") && !o.get("topP").isJsonNull()) {
            s.setTopP(o.get("topP").getAsDouble());
        }
        if (o.has("stop") && o.get("stop").isJsonArray()) {
            List<String> stop = new ArrayList<>();
            for (int i = 0; i < o.getAsJsonArray("stop").size(); i++) {
                stop.add(o.getAsJsonArray("stop").get(i).getAsString());
            }
            s.setStop(stop);
        }
        if (o.has("ignoreEos") && !o.get("ignoreEos").isJsonNull()) {
            s.setIgnoreEos(o.get("ignoreEos").getAsBoolean());
        }
        if (o.has("debounceMs") && !o.get("debounceMs").isJsonNull()) {
            s.setDebounceMs(o.get("debounceMs").getAsInt());
        }
        s.normalize();
        return s;
    }

    public static CodeCompletionSettings fromJsonString(String json) {
        if (json == null || json.trim().isEmpty()) {
            return new CodeCompletionSettings();
        }
        try {
            return fromJson(JsonParser.parseString(json).getAsJsonObject());
        } catch (Exception e) {
            return new CodeCompletionSettings();
        }
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof CodeCompletionSettings)) {
            return false;
        }
        CodeCompletionSettings that = (CodeCompletionSettings) o;
        return enabled == that.enabled
                && maxTokens == that.maxTokens
                && Double.compare(that.temperature, temperature) == 0
                && Double.compare(that.topP, topP) == 0
                && ignoreEos == that.ignoreEos
                && debounceMs == that.debounceMs
                && Objects.equals(preset, that.preset)
                && Objects.equals(baseUrl, that.baseUrl)
                && Objects.equals(path, that.path)
                && Objects.equals(apiKey, that.apiKey)
                && Objects.equals(model, that.model)
                && Objects.equals(stop, that.stop);
    }

    @Override
    public int hashCode() {
        return Objects.hash(enabled, preset, baseUrl, path, apiKey, model, maxTokens, temperature, topP, stop, ignoreEos, debounceMs);
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionSettingsTest -PskipWebview=true`
预期：PASS（全部用例）。

- [ ] **步骤 5：修正旧 getter 的其它引用（主代码 + 另一个测试文件）**

**(a)** `src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java` 的 `setCodeCompletionSettings` 日志：

```java
        LOG.info("[CodemossSettingsService] Saved codeCompletion (enabled=" + settings.isEnabled()
                + ", preset=" + settings.getPreset() + ")");
```

**(b)** `src/test/java/com/github/claudecodegui/settings/CodemossSettingsServiceCompletionTest.java` 也在用旧 getter，不改会编译失败：

`getDefaultsWhenSectionMissing` 中：

```java
        assertFalse(s.isEnabled());
        assertEquals("deepseek", s.getSource());
```
改为：
```java
        assertFalse(s.isEnabled());
        assertEquals(CodeCompletionSettings.PRESET_DEEPSEEK, s.getPreset());
        assertEquals(CodeCompletionSettings.DEEPSEEK_PATH, s.getPath());
```

`roundTripsPersistedSettings` 中：

```java
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setSource("custom");
        s.setBaseUrl("https://example.com");
```
改为：
```java
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setEnabled(true);
        s.setPreset(CodeCompletionSettings.PRESET_CUSTOM);
        s.setBaseUrl("https://example.com");
        s.setPath("/v1/completions");
```
并把断言：
```java
        assertEquals("custom", loaded.getSource());
        assertEquals("https://example.com/", loaded.getBaseUrl());
```
改为：
```java
        assertEquals(CodeCompletionSettings.PRESET_CUSTOM, loaded.getPreset());
        // normalize() now strips the trailing slash instead of adding one.
        assertEquals("https://example.com", loaded.getBaseUrl());
        assertEquals("/v1/completions", loaded.getPath());
```

运行：`./gradlew test --tests "com.github.claudecodegui.settings.CodeCompletionSettingsTest" --tests "com.github.claudecodegui.settings.CodemossSettingsServiceCompletionTest" -PskipWebview=true`
预期：BUILD SUCCESSFUL（两个测试类全绿）。

- [ ] **步骤 6：Commit（人工执行）**

```bash
git add src/main/java/com/github/claudecodegui/settings/CodeCompletionSettings.java \
        src/main/java/com/github/claudecodegui/settings/CodemossSettingsService.java \
        src/test/java/com/github/claudecodegui/settings/CodeCompletionSettingsTest.java
git commit -m "feat(completion): add preset/path config with legacy migration"
```

---

### 任务 2：`DeepSeekFimClient` 支持可配置 path 与可见错误

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java`（整文件替换）
- 测试：`src/test/java/com/github/claudecodegui/provider/common/DeepSeekFimClientTest.java`

- [ ] **步骤 1：编写失败的测试**

整文件替换 `DeepSeekFimClientTest.java`：

```java
package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.settings.CodeCompletionSettings;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.*;

public class DeepSeekFimClientTest {

    private static String okBody(String text) {
        JsonObject choice = new JsonObject();
        choice.addProperty("text", text);
        JsonArray choices = new JsonArray();
        choices.add(choice);
        JsonObject root = new JsonObject();
        root.add("choices", choices);
        return root.toString();
    }

    @Test
    public void buildsEndpointFromBaseUrlAndPath() {
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com", "/beta/completions"));
        assertEquals("https://api.deepseek.com/beta/completions",
                DeepSeekFimClient.buildEndpoint("https://api.deepseek.com/", "beta/completions"));
        assertEquals("https://api.siliconflow.cn/v1/completions",
                DeepSeekFimClient.buildEndpoint("https://api.siliconflow.cn/", "/v1/completions"));
        assertEquals("", DeepSeekFimClient.buildEndpoint("", "/v1/completions"));
    }

    @Test
    public void buildsRequestBodyWithPathIndependentFields() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        JsonObject body = DeepSeekFimClient.buildRequestBody("pre", "suf", s);
        assertEquals("deepseek-flash", body.get("model").getAsString());
        assertEquals("pre", body.get("prompt").getAsString());
        assertEquals("suf", body.get("suffix").getAsString());
        assertEquals(256, body.get("max_tokens").getAsInt());
        assertFalse(body.get("stream").getAsBoolean());
        assertEquals("\n\n", body.getAsJsonArray("stop").get(0).getAsString());
    }

    @Test
    public void parsesCompletionText() {
        assertEquals("int x = 1;", DeepSeekFimClient.parseCompletionText(okBody("int x = 1;")));
        assertNull(DeepSeekFimClient.parseCompletionText("{\"choices\":[]}"));
        assertNull(DeepSeekFimClient.parseCompletionText("{not json"));
        assertNull(DeepSeekFimClient.parseCompletionText(null));
    }

    @Test
    public void callReturnsStatusAndText() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body) ->
                new DeepSeekFimClient.HttpResult(200, okBody("return 42;"), null));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertTrue(r.ok);
        assertEquals(200, r.httpStatus);
        assertEquals("return 42;", r.text);
        assertEquals("https://api.deepseek.com/v1/completions", r.endpoint);
    }

    @Test
    public void callSurfacesHttpErrorForTestConnection() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body) ->
                new DeepSeekFimClient.HttpResult(404, "{\"error\":\"not found\"}", null));
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertFalse(r.ok);
        assertEquals(404, r.httpStatus);
        assertTrue(r.error.contains("404"));
        assertTrue(r.error.contains("not found"));
    }

    @Test
    public void callSurfacesTransportFailure() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body) -> {
            throw new IllegalStateException("connection refused");
        });
        DeepSeekFimClient.CallResult r = client.call("a", "b", cfg("/v1/completions"), "k").join();
        assertFalse(r.ok);
        assertTrue(r.error.contains("connection refused"));
    }

    @Test
    public void completeReturnsNullOnFailure() {
        DeepSeekFimClient client = new DeepSeekFimClient((url, apiKey, body) ->
                new DeepSeekFimClient.HttpResult(401, "unauthorized", null));
        assertNull(client.complete("a", "b", cfg("/v1/completions"), "k").join());
    }

    private static CodeCompletionSettings cfg(String path) {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.deepseek.com");
        s.setPath(path);
        s.normalize();
        return s;
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.provider.common.DeepSeekFimClientTest -PskipWebview=true`
预期：编译失败（`HttpResult`/`CallResult`/`call`/`buildEndpoint(String,String)` 不存在）。

- [ ] **步骤 3：整文件替换 `DeepSeekFimClient.java`**

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
 * Calls an OpenAI-compatible completions endpoint (FIM):
 * {@code POST {baseUrl}{path}} with {@code prompt} + {@code suffix}.
 *
 * <p>Works for any provider exposing that shape — DeepSeek official
 * ({@code /beta/completions}), SiliconFlow and other gateways
 * ({@code /v1/completions}). The response text ({@code choices[0].text}) is the
 * middle fragment to insert between prefix and suffix.
 *
 * <p>Never throws to callers: failures are reported through
 * {@link CallResult} (used by the "test connection" UI) or {@code null}
 * (used by the editor, which stays silent).
 */
public final class DeepSeekFimClient {

    private static final Logger LOG = Logger.getInstance(DeepSeekFimClient.class);
    private static final int HTTP_TIMEOUT_MS = 5000;

    /** Transport seam for tests. */
    @FunctionalInterface
    public interface Transport {
        HttpResult post(String url, String apiKey, String body) throws Exception;
    }

    /** Raw HTTP outcome; {@code error} is non-null when the call itself failed. */
    public static final class HttpResult {
        public final int status;
        public final String body;
        public final String error;

        public HttpResult(int status, String body, String error) {
            this.status = status;
            this.body = body;
            this.error = error;
        }
    }

    /** Outcome of one FIM call, with everything the UI needs to explain a failure. */
    public static final class CallResult {
        public final boolean ok;
        public final int httpStatus;
        public final String text;
        public final String error;
        public final String endpoint;

        CallResult(boolean ok, int httpStatus, String text, String error, String endpoint) {
            this.ok = ok;
            this.httpStatus = httpStatus;
            this.text = text;
            this.error = error;
            this.endpoint = endpoint;
        }
    }

    private final Transport transport;

    public DeepSeekFimClient() {
        this(DeepSeekFimClient::httpPost);
    }

    DeepSeekFimClient(Transport transport) {
        this.transport = transport;
    }

    /** Full outcome, for the "test connection" action. */
    public CompletableFuture<CallResult> call(String prefix, String suffix,
                                              CodeCompletionSettings cfg, String apiKey) {
        return CompletableFuture.supplyAsync(() -> doCall(prefix, suffix, cfg, apiKey));
    }

    /** Completion text or {@code null}; the editor stays silent on failure. */
    public CompletableFuture<String> complete(String prefix, String suffix,
                                              CodeCompletionSettings cfg, String apiKey) {
        return call(prefix, suffix, cfg, apiKey).thenApply(r -> r.ok ? r.text : null);
    }

    private CallResult doCall(String prefix, String suffix,
                              CodeCompletionSettings cfg, String apiKey) {
        String endpoint = "";
        try {
            cfg.normalize();
            endpoint = buildEndpoint(cfg.getBaseUrl(), cfg.getPath());
            if (endpoint.isEmpty()) {
                return new CallResult(false, 0, null, "Base URL is not set", endpoint);
            }
            String body = buildRequestBody(prefix, suffix, cfg).toString();
            HttpResult res = transport.post(endpoint, apiKey, body);
            if (res.error != null) {
                return new CallResult(false, res.status, null, res.error, endpoint);
            }
            if (res.status != 200) {
                return new CallResult(false, res.status, null,
                        "HTTP " + res.status + ": " + abbreviate(res.body), endpoint);
            }
            String text = parseCompletionText(res.body);
            if (text == null || text.isEmpty()) {
                return new CallResult(false, res.status, null,
                        "Response contained no completion text", endpoint);
            }
            return new CallResult(true, res.status, text, null, endpoint);
        } catch (Exception e) {
            LOG.debug("[FimClient] completion failed: " + e.getMessage());
            return new CallResult(false, 0, null, String.valueOf(e.getMessage()), endpoint);
        }
    }

    static String buildEndpoint(String baseUrl, String path) {
        String base = baseUrl == null ? "" : baseUrl.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.isEmpty()) {
            return "";
        }
        String p = path == null ? "" : path.trim();
        if (p.startsWith("http://") || p.startsWith("https://")) {
            return "";
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        return base + p;
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
        for (String s : cfg.getStop()) {
            stop.add(s);
        }
        o.add("stop", stop);
        o.addProperty("ignore_eos", cfg.isIgnoreEos());
        o.addProperty("stream", false);
        return o;
    }

    static String parseCompletionText(String responseBody) {
        if (responseBody == null || responseBody.trim().isEmpty()) {
            return null;
        }
        try {
            JsonObject root = JsonParser.parseString(responseBody).getAsJsonObject();
            if (!root.has("choices") || !root.get("choices").isJsonArray()
                    || root.getAsJsonArray("choices").isEmpty()) {
                return null;
            }
            JsonObject first = root.getAsJsonArray("choices").get(0).getAsJsonObject();
            if (!first.has("text") || first.get("text").isJsonNull()) {
                return null;
            }
            String text = first.get("text").getAsString();
            return text == null || text.isEmpty() ? null : text;
        } catch (Exception e) {
            LOG.debug("[FimClient] failed to parse response: " + e.getMessage());
            return null;
        }
    }

    private static String abbreviate(String s) {
        if (s == null) {
            return "";
        }
        String oneLine = s.replace('\n', ' ').replace('\r', ' ');
        return oneLine.length() > 500 ? oneLine.substring(0, 500) : oneLine;
    }

    private static HttpResult httpPost(String url, String apiKey, String body) throws Exception {
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
        return new HttpResult(resp.statusCode(), resp.body(), null);
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.provider.common.DeepSeekFimClientTest -PskipWebview=true`
预期：PASS。

- [ ] **步骤 5：Commit（人工执行）**

```bash
git add src/main/java/com/github/claudecodegui/provider/common/DeepSeekFimClient.java \
        src/test/java/com/github/claudecodegui/provider/common/DeepSeekFimClientTest.java
git commit -m "feat(completion): configurable endpoint path and surfaced http errors"
```

---

### 任务 3：`CodeCompletionCredentialResolver` 凭证复用

**文件：**
- 创建：`src/main/java/com/github/claudecodegui/settings/CodeCompletionCredentialResolver.java`
- 测试：`src/test/java/com/github/claudecodegui/settings/CodeCompletionCredentialResolverTest.java`

- [ ] **步骤 1：编写失败的测试**

```java
package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.*;

public class CodeCompletionCredentialResolverTest {

    private static JsonObject provider(String name, String baseUrl, String apiKey) {
        JsonObject p = new JsonObject();
        p.addProperty("name", name);
        p.addProperty("baseUrl", baseUrl);
        if (apiKey != null) {
            p.addProperty("apiKey", apiKey);
        }
        return p;
    }

    @Test
    public void sameHostMatchesExactAndSubdomain() {
        assertTrue(CodeCompletionCredentialResolver.sameHost("https://api.deepseek.com/v1", "https://api.deepseek.com"));
        assertTrue(CodeCompletionCredentialResolver.sameHost("https://sub.example.com", "https://example.com"));
        assertFalse(CodeCompletionCredentialResolver.sameHost("https://notdeepseek.com", "https://deepseek.com"));
        assertFalse(CodeCompletionCredentialResolver.sameHost("", "https://deepseek.com"));
    }

    @Test
    public void explicitKeyWins() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setApiKey("sk-explicit");
        s.setBaseUrl("https://api.deepseek.com");
        CodeCompletionCredentialResolver.Resolution r =
                CodeCompletionCredentialResolver.pick(s, new JsonObject[] { provider("DS", "https://api.deepseek.com", "sk-stored") });
        assertEquals("sk-explicit", r.apiKey);
        assertEquals("", r.sourceName);
    }

    @Test
    public void reusesProviderKeyByHost() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.deepseek.com");
        CodeCompletionCredentialResolver.Resolution r =
                CodeCompletionCredentialResolver.pick(s, new JsonObject[] { provider("DeepSeek-V4-Pro", "https://api.deepseek.com/anthropic", "sk-a0") });
        assertEquals("sk-a0", r.apiKey);
        assertEquals("DeepSeek-V4-Pro", r.sourceName);
    }

    @Test
    public void fallsBackToAnthropicEnvToken() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.siliconflow.cn");
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "sk-env");
        JsonObject p = provider("SiliconFlow", "https://api.siliconflow.cn", null);
        p.add("env", env);
        CodeCompletionCredentialResolver.Resolution r =
                CodeCompletionCredentialResolver.pick(s, new JsonObject[] { p });
        assertEquals("sk-env", r.apiKey);
        assertEquals("SiliconFlow", r.sourceName);
    }

    @Test
    public void noMatchYieldsEmptyKey() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://unknown.example.com");
        CodeCompletionCredentialResolver.Resolution r =
                CodeCompletionCredentialResolver.pick(s, new JsonObject[] { provider("X", "https://other.com", "sk-x") });
        assertEquals("", r.apiKey);
        assertEquals("", r.sourceName);
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionCredentialResolverTest -PskipWebview=true`
预期：编译失败（类不存在）。

- [ ] **步骤 3：创建实现**

```java
package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.List;

/**
 * Resolves the API key used for code completion.
 *
 * <p>An explicitly configured key always wins. Otherwise the key is borrowed
 * from an already-configured provider (Claude or Codex provider list) whose
 * {@code baseUrl} points at the same host — so users do not paste the same key
 * twice. Nothing is persisted: the provider list stays the single source of
 * truth and key rotations are picked up automatically.
 */
public final class CodeCompletionCredentialResolver {

    private static final Logger LOG = Logger.getInstance(CodeCompletionCredentialResolver.class);
    private static final String[] TOKEN_KEYS = {"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "apiKey"};

    private CodeCompletionCredentialResolver() {
    }

    /** Resolved credential plus the provider it came from ("" when not borrowed). */
    public static final class Resolution {
        public final String apiKey;
        public final String sourceName;

        Resolution(String apiKey, String sourceName) {
            this.apiKey = apiKey;
            this.sourceName = sourceName;
        }
    }

    /** Resolve using the plugin config file. Never throws. */
    public static Resolution resolve(CodeCompletionSettings settings) {
        try {
            JsonObject config = new CodemossSettingsService().readConfig();
            return pick(settings, collectProviders(config));
        } catch (Exception e) {
            LOG.debug("[CodeCompletionCredentialResolver] failed to read providers: " + e.getMessage());
            return new Resolution(settings == null ? "" : settings.getApiKey(), "");
        }
    }

    static JsonObject[] collectProviders(JsonObject config) {
        List<JsonObject> out = new ArrayList<>();
        for (String section : new String[] {"claude", "codex"}) {
            if (!config.has(section) || config.get(section).isJsonNull()) {
                continue;
            }
            JsonObject s = config.getAsJsonObject(section);
            if (!s.has("providers") || s.get("providers").isJsonNull()) {
                continue;
            }
            for (String id : s.getAsJsonObject("providers").keySet()) {
                JsonObject p = s.getAsJsonObject("providers").getAsJsonObject(id);
                if (p != null && !p.isJsonNull()) {
                    out.add(p);
                }
            }
        }
        return out.toArray(new JsonObject[0]);
    }

    static Resolution pick(CodeCompletionSettings settings, JsonObject[] providers) {
        if (settings == null) {
            return new Resolution("", "");
        }
        String explicit = settings.getApiKey();
        if (explicit != null && !explicit.isEmpty()) {
            return new Resolution(explicit, "");
        }
        String target = settings.getBaseUrl();
        for (JsonObject p : providers) {
            if (p == null) {
                continue;
            }
            String baseUrl = stringOf(p, "baseUrl");
            if (!sameHost(baseUrl, target)) {
                continue;
            }
            String key = extractToken(p);
            if (!key.isEmpty()) {
                return new Resolution(key, stringOf(p, "name"));
            }
        }
        return new Resolution("", "");
    }

    private static String extractToken(JsonObject provider) {
        String direct = stringOf(provider, "apiKey");
        if (!direct.isEmpty()) {
            return direct;
        }
        if (provider.has("env") && provider.get("env").isJsonObject()) {
            JsonObject env = provider.getAsJsonObject("env");
            for (String k : TOKEN_KEYS) {
                if (env.has(k) && !env.get(k).isJsonNull()) {
                    String v = env.get(k).getAsString();
                    if (v != null && !v.isEmpty()) {
                        return v;
                    }
                }
            }
        }
        return "";
    }

    private static String stringOf(JsonObject o, String key) {
        if (o.has(key) && !o.get(key).isJsonNull()) {
            String v = o.get(key).getAsString();
            return v == null ? "" : v;
        }
        return "";
    }

    /** True when both URLs point at the same host (subdomains count as matches). */
    static boolean sameHost(String a, String b) {
        String ha = hostOf(a);
        String hb = hostOf(b);
        if (ha.isEmpty() || hb.isEmpty()) {
            return false;
        }
        return ha.equalsIgnoreCase(hb)
                || ha.toLowerCase().endsWith("." + hb.toLowerCase())
                || hb.toLowerCase().endsWith("." + ha.toLowerCase());
    }

    private static String hostOf(String url) {
        return CodeCompletionSettings.hostOf(url);
    }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./gradlew test --tests com.github.claudecodegui.settings.CodeCompletionCredentialResolverTest -PskipWebview=true`
预期：PASS。

- [ ] **步骤 5：Commit（人工执行）**

```bash
git add src/main/java/com/github/claudecodegui/settings/CodeCompletionCredentialResolver.java \
        src/test/java/com/github/claudecodegui/settings/CodeCompletionCredentialResolverTest.java
git commit -m "feat(completion): reuse configured provider credentials by host"
```

---

### 任务 4：bridge —— 有效 key 回显 + 「测试连接」

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java`（`handleGetCodeCompletionSettings` 与新增 `handleTestCodeCompletionSettings`）
- 修改：`src/main/java/com/github/claudecodegui/handler/SettingsHandler.java`（`SUPPORTED_TYPES` + switch case）
- 测试：无（依赖 IDE 运行时的 handler，逻辑已在任务 2/3 覆盖）

- [ ] **步骤 1：改 `handleGetCodeCompletionSettings`（回显有效 key 与来源）**

把现有方法体替换为：

```java
    public void handleGetCodeCompletionSettings() {
        try {
            CodeCompletionSettings settings = settingsService.getCodeCompletionSettings();
            CodeCompletionCredentialResolver.Resolution resolved =
                    CodeCompletionCredentialResolver.resolve(settings);
            JsonObject payload = settings.toJson();
            payload.addProperty("apiKey", maskApiKey(resolved.apiKey));
            payload.addProperty("apiKeyResolvedFrom", resolved.sourceName);
            pushJson("window.updateCodeCompletionSettings", payload);
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] Failed to get code completion settings: " + e.getMessage(), e);
            showError("Failed to load code completion settings: " + e.getMessage());
        }
    }
```

并在 import 区加入：

```java
import com.github.claudecodegui.settings.CodeCompletionCredentialResolver;
```

- [ ] **步骤 2：修补 `handleSetCodeCompletionSettings` 的掩码识别**

**为什么必须补**：GET 现在可能回显「借来的 provider key 的掩码」，而此时已存 key 是空串。原判断「空 或 == mask(已存key)」会漏掉这种情况 —— 掩码串既不空也不等于 `""`，会被当成真 key 写进配置，之后请求必然 401。

把这些行（`handleSetCodeCompletionSettings` 内）：

```java
            if (incomingKey == null || incomingKey.isEmpty()
                    || incomingKey.equals(maskApiKey(storedKey))) {
                // Empty or masked → keep what is already stored.
                incoming.setApiKey(storedKey);
            }
```

替换为：

```java
            if (incomingKey == null || incomingKey.isEmpty()
                    || looksMasked(incomingKey)
                    || incomingKey.equals(maskApiKey(storedKey))) {
                // Empty or masked → keep what is already stored. A masked value can
                // arrive even when nothing is stored, because GET echoes the mask of
                // a key borrowed from a configured provider.
                incoming.setApiKey(storedKey);
            }
```

并在 `maskApiKey` 旁边新增：

```java
    /** True when a value is one of our masked previews rather than a real key. */
    private static boolean looksMasked(String value) {
        return value != null && value.contains("****");
    }
```

- [ ] **步骤 3：新增 `handleTestCodeCompletionSettings`**

紧随 `handleSetCodeCompletionSettings` 之后插入：

```java
    /**
     * Handle test_code_completion: run one real FIM call with the current
     * settings and push the outcome (status, error text, snippet) back to the
     * webview. This is the primary way to diagnose a silent "no suggestion".
     */
    public void handleTestCodeCompletionSettings() {
        try {
            CodeCompletionSettings settings = settingsService.getCodeCompletionSettings();
            CodeCompletionCredentialResolver.Resolution resolved =
                    CodeCompletionCredentialResolver.resolve(settings);
            if (resolved.apiKey == null || resolved.apiKey.isEmpty()) {
                JsonObject payload = new JsonObject();
                payload.addProperty("ok", false);
                payload.addProperty("error", "No API key configured");
                pushJson("window.onCodeCompletionTestResult", payload);
                return;
            }
            DeepSeekFimClient client = new DeepSeekFimClient();
            client.call(TEST_PROMPT, TEST_SUFFIX, settings, resolved.apiKey)
                    .orTimeout(TEST_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
                    .whenComplete((result, err) -> {
                        JsonObject payload = new JsonObject();
                        if (result != null) {
                            payload.addProperty("ok", result.ok);
                            payload.addProperty("httpStatus", result.httpStatus);
                            payload.addProperty("endpoint", result.endpoint);
                            if (result.ok) {
                                payload.addProperty("snippet", truncate(result.text, 500));
                            } else {
                                payload.addProperty("error", truncate(result.error, 500));
                            }
                        } else {
                            payload.addProperty("ok", false);
                            payload.addProperty("error", err == null ? "Unknown error" : String.valueOf(err.getMessage()));
                        }
                        pushJson("window.onCodeCompletionTestResult", payload);
                    });
        } catch (Exception e) {
            LOG.error("[ProjectConfigHandler] failed to test code completion: " + e.getMessage(), e);
            showError("Failed to test code completion: " + e.getMessage());
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() > max ? s.substring(0, max) : s;
    }
```

在类字段区加入常量与 import：

```java
    private static final String TEST_PROMPT = "public static int add(int a, int b) {";
    private static final String TEST_SUFFIX = "}";
    private static final int TEST_TIMEOUT_SECONDS = 15;
```

```java
import com.github.claudecodegui.provider.common.DeepSeekFimClient;
```

- [ ] **步骤 4：在 `SettingsHandler` 注册新类型**

`SUPPORTED_TYPES` 数组里，紧跟 `"set_code_completion_settings",` 之后加入：

```java
        "test_code_completion",
```

switch 里，紧跟 `set_code_completion_settings` 的 case 之后加入：

```java
            case "test_code_completion":
                projectConfigHandler.handleTestCodeCompletionSettings();
                return true;
```

- [ ] **步骤 5：编译验证**

运行：`./gradlew compileJava -PskipWebview=true`
预期：BUILD SUCCESSFUL。

- [ ] **步骤 6：Commit（人工执行）**

```bash
git add src/main/java/com/github/claudecodegui/handler/ProjectConfigHandler.java \
        src/main/java/com/github/claudecodegui/handler/SettingsHandler.java
git commit -m "feat(completion): add test-connection bridge and effective key resolution"
```

---

### 任务 5：编辑器侧使用 path 与解析后的 key

**文件：**
- 修改：`src/main/java/com/github/claudecodegui/completion/FimCompletionContributor.java`

- [ ] **步骤 1：替换配置读取与调用点（两处精确替换）**

**替换 A** —— 找到现有这段（`addFimVariant` 内）：

```java
        CodeCompletionSettings cfg;
        try {
            cfg = new CodemossSettingsService().getCodeCompletionSettings();
        } catch (Exception e) {
            return;
        }
        if (cfg == null || !cfg.isEnabled()) {
            return;
        }
```

替换为：

```java
        CodeCompletionSettings cfg;
        try {
            cfg = new CodemossSettingsService().getCodeCompletionSettings();
        } catch (Exception e) {
            return;
        }
        if (cfg == null || !cfg.isEnabled()) {
            return;
        }
        String apiKey = CodeCompletionCredentialResolver.resolve(cfg).apiKey;
        if (apiKey == null || apiKey.isEmpty()) {
            return;
        }
```

**替换 B** —— 找到现有这段：

```java
        String fragment;
        try {
            CompletableFuture<String> future = client.complete(ctx.prefix, ctx.suffix, cfg);
            fragment = future.get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            LOG.debug("[FimCompletion] request failed/timed out: " + e.getMessage());
            return;
        }
```

替换为：

```java
        String fragment;
        try {
            CompletableFuture<String> future = client.complete(ctx.prefix, ctx.suffix, cfg, apiKey);
            fragment = future.get(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            LOG.debug("[FimCompletion] request failed/timed out: " + e.getMessage());
            return;
        }
```

新增 import：

```java
import com.github.claudecodegui.settings.CodeCompletionCredentialResolver;
```

- [ ] **步骤 2：编译并回归既有单测**

运行：`./gradlew compileJava test --tests "com.github.claudecodegui.completion.*" -PskipWebview=true`
预期：BUILD SUCCESSFUL，`FimCompletionLogicTest` 全绿。

- [ ] **步骤 3：Commit（人工执行）**

```bash
git add src/main/java/com/github/claudecodegui/completion/FimCompletionContributor.java
git commit -m "feat(completion): use configured path and resolved credentials"
```

---

### 任务 6：webview —— 平台预置、path、测试连接

**文件：**
- 修改：`webview/src/components/settings/CodeCompletionSection/index.tsx`
- 修改：`webview/src/global.d.ts`
- 修改：`webview/src/i18n/locales/en.json`、`zh.json`
- 测试：`webview/src/components/settings/CodeCompletionSection/index.test.tsx`

- [ ] **步骤 1：编写失败的测试**

整文件替换 `index.test.tsx`：

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CodeCompletionSection from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const persisted = {
  enabled: true,
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  path: '/beta/completions',
  apiKey: 'sk-ab****cdef',
  model: 'deepseek-flash',
  maxTokens: 1024,
  temperature: 1,
  topP: 1,
  stop: ['\n\n'],
  ignoreEos: false,
  debounceMs: 300,
};

describe('CodeCompletionSection', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
    window.updateCodeCompletionSettings = undefined;
    window.onCodeCompletionTestResult = undefined;
  });

  it('requests the persisted config on mount', () => {
    render(<CodeCompletionSection />);
    expect(window.sendToJava).toHaveBeenCalledWith('get_code_completion_settings:');
  });

  it('fills baseUrl and path from the selected preset', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'siliconflow' } });
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://api.siliconflow.cn');
    expect((screen.getByLabelText('Endpoint path') as HTMLInputElement).value).toBe('/v1/completions');
  });

  it('shows the returned snippet on a successful test', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    fireEvent.click(screen.getByTestId('code-completion-test'));
    expect(window.sendToJava).toHaveBeenCalledWith('test_code_completion:');

    act(() => window.onCodeCompletionTestResult?.(JSON.stringify({
      ok: true, httpStatus: 200, snippet: '    return a + b;', endpoint: 'https://api.deepseek.com/beta/completions',
    })));
    expect(screen.getByTestId('code-completion-test-result').textContent).toContain('return a + b;');
  });

  it('shows the error on a failed test', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    act(() => window.onCodeCompletionTestResult?.(JSON.stringify({
      ok: false, httpStatus: 404, error: 'HTTP 404: not found', endpoint: 'https://x/v1/completions',
    })));
    expect(screen.getByTestId('code-completion-test-result').textContent).toContain('HTTP 404');
  });

  it('saves preset and path in the payload', () => {
    render(<CodeCompletionSection />);
    act(() => window.updateCodeCompletionSettings?.(JSON.stringify(persisted)));

    const sendToJava = window.sendToJava as ReturnType<typeof vi.fn>;
    sendToJava.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'settings.codeCompletion.save' }));

    const sent = sendToJava.mock.calls[0][0] as string;
    const payload = JSON.parse(sent.slice('set_code_completion_settings:'.length));
    expect(payload.preset).toBe('deepseek');
    expect(payload.path).toBe('/beta/completions');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd webview && npx vitest run src/components/settings/CodeCompletionSection/index.test.tsx`
预期：FAIL（无 Preset/Endpoint path 字段、无测试连接按钮）。

- [ ] **步骤 3：替换 `CodeCompletionSection/index.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export interface CodeCompletionConfig {
  enabled: boolean;
  preset: 'deepseek' | 'siliconflow' | 'custom';
  baseUrl: string;
  path: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  stop: string[];
  ignoreEos: boolean;
  debounceMs: number;
}

interface Preset {
  id: CodeCompletionConfig['preset'];
  label: string;
  baseUrl: string;
  path: string;
  models: string[];
}

/** Only platforms verified to expose a real FIM/completions endpoint. */
export const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    path: '/beta/completions',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn',
    path: '/v1/completions',
    models: [
      'deepseek-ai/DeepSeek-V4-Flash',
      'deepseek-ai/DeepSeek-V3.2',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    ],
  },
  { id: 'custom', label: 'Custom', baseUrl: '', path: '/v1/completions', models: [] },
];

export const DEFAULT_CODE_COMPLETION_CONFIG: CodeCompletionConfig = {
  enabled: false,
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  path: '/beta/completions',
  apiKey: '',
  model: 'deepseek-flash',
  maxTokens: 256,
  temperature: 1.0,
  topP: 1.0,
  stop: ['\n\n'],
  ignoreEos: false,
  debounceMs: 300,
};

interface TestResult {
  ok: boolean;
  httpStatus?: number;
  snippet?: string;
  error?: string;
  endpoint?: string;
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function toConfig(json: string): CodeCompletionConfig {
  let data: any = {};
  try {
    data = JSON.parse(json || '{}');
  } catch {
    data = {};
  }
  const base = DEFAULT_CODE_COMPLETION_CONFIG;
  const preset: CodeCompletionConfig['preset'] =
    data.preset === 'siliconflow' || data.preset === 'custom' ? data.preset : 'deepseek';
  return {
    enabled: toBoolean(data.enabled, base.enabled),
    preset,
    baseUrl: typeof data.baseUrl === 'string' && data.baseUrl ? data.baseUrl : base.baseUrl,
    path: typeof data.path === 'string' && data.path ? data.path : base.path,
    apiKey: typeof data.apiKey === 'string' ? data.apiKey : base.apiKey,
    model: typeof data.model === 'string' && data.model ? data.model : base.model,
    maxTokens: toNumber(data.maxTokens, base.maxTokens),
    temperature: toNumber(data.temperature, base.temperature),
    topP: toNumber(data.topP, base.topP),
    stop: Array.isArray(data.stop) ? data.stop.map(String) : base.stop,
    ignoreEos: toBoolean(data.ignoreEos, base.ignoreEos),
    debounceMs: toNumber(data.debounceMs, base.debounceMs),
  };
}

const CodeCompletionSection = () => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CodeCompletionConfig>(DEFAULT_CODE_COMPLETION_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [resolvedFrom, setResolvedFrom] = useState('');
  const prevSettingsCallback = useRef<((json: string) => void) | undefined>(undefined);
  const prevTestCallback = useRef<((json: string) => void) | undefined>(undefined);

  useEffect(() => {
    window.sendToJava?.('get_code_completion_settings:');
  }, []);

  useEffect(() => {
    prevSettingsCallback.current = window.updateCodeCompletionSettings;
    window.updateCodeCompletionSettings = (json: string) => {
      let from = '';
      try {
        from = JSON.parse(json || '{}').apiKeyResolvedFrom || '';
      } catch {
        from = '';
      }
      setDraft(toConfig(json));
      setResolvedFrom(from);
      setLoaded(true);
    };
    prevTestCallback.current = window.onCodeCompletionTestResult;
    window.onCodeCompletionTestResult = (json: string) => {
      try {
        setTestResult(JSON.parse(json || '{}'));
      } catch {
        setTestResult({ ok: false, error: 'Malformed test result' });
      }
      setTesting(false);
    };
    return () => {
      window.updateCodeCompletionSettings = prevSettingsCallback.current;
      window.onCodeCompletionTestResult = prevTestCallback.current;
    };
  }, []);

  const set = useCallback(<K extends keyof CodeCompletionConfig>(key: K, value: CodeCompletionConfig[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const applyPreset = useCallback((id: CodeCompletionConfig['preset']) => {
    const p = PRESETS.find((x) => x.id === id);
    setDraft((d) => ({
      ...d,
      preset: id,
      baseUrl: p && p.baseUrl ? p.baseUrl : d.baseUrl,
      path: p && p.path ? p.path : d.path,
      model: p && p.models.length > 0 ? p.models[0] : d.model,
    }));
    setTestResult(null);
  }, []);

  const handleSave = useCallback(() => {
    setSaving(true);
    window.sendToJava?.(`set_code_completion_settings:${JSON.stringify(draft)}`);
    window.setTimeout(() => setSaving(false), 400);
  }, [draft]);

  const handleTest = useCallback(() => {
    setTesting(true);
    setTestResult(null);
    window.sendToJava?.('test_code_completion:');
  }, []);

  const apiKeyStored = draft.apiKey.includes('****');

  return (
    <div className={styles.section}>
      <h3>{t('settings.codeCompletion.groupTitle')}</h3>
      <p className={styles.description}>{t('settings.codeCompletion.description')}</p>

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
        <span className={styles.label}>{t('settings.codeCompletion.preset')}</span>
        <select
          className={styles.input}
          aria-label="Preset"
          value={draft.preset}
          onChange={(e) => applyPreset(e.target.value as CodeCompletionConfig['preset'])}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.baseUrl')}</span>
        <input
          className={styles.input}
          aria-label="Base URL"
          value={draft.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.path')}</span>
        <input
          className={styles.input}
          aria-label="Endpoint path"
          value={draft.path}
          onChange={(e) => set('path', e.target.value)}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.apiKey')}</span>
        <input
          type="password"
          className={styles.input}
          aria-label="API Key"
          placeholder={apiKeyStored ? '••••••••' : ''}
          value={draft.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
        />
      </label>
      {resolvedFrom && (
        <p className={styles.hint}>{t('settings.codeCompletion.reusedFrom', { provider: resolvedFrom })}</p>
      )}
      {apiKeyStored && !resolvedFrom && (
        <p className={styles.hint}>{t('settings.codeCompletion.apiKeyHint')}</p>
      )}

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.model')}</span>
        <input
          className={styles.input}
          aria-label="Model"
          list="code-completion-model-list"
          value={draft.model}
          onChange={(e) => set('model', e.target.value)}
        />
        <datalist id="code-completion-model-list">
          {(PRESETS.find((p) => p.id === draft.preset)?.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.maxTokens')}</span>
        <input
          type="number"
          className={styles.input}
          aria-label="Max Tokens"
          min={1}
          max={8192}
          value={draft.maxTokens}
          onChange={(e) => set('maxTokens', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.maxTokens))}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.temperature')}</span>
        <input
          type="number"
          step="0.1"
          min={0}
          max={2}
          className={styles.input}
          aria-label="Temperature"
          value={draft.temperature}
          onChange={(e) => set('temperature', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.temperature))}
        />
      </label>

      <label className={styles.row}>
        <span className={styles.label}>{t('settings.codeCompletion.topP')}</span>
        <input
          type="number"
          step="0.05"
          min={0}
          max={1}
          className={styles.input}
          aria-label="Top P"
          value={draft.topP}
          onChange={(e) => set('topP', toNumber(e.target.value, DEFAULT_CODE_COMPLETION_CONFIG.topP))}
        />
      </label>

      <label className={styles.row}>
        <input
          type="checkbox"
          aria-label="Ignore EOS"
          checked={draft.ignoreEos}
          onChange={(e) => set('ignoreEos', e.target.checked)}
        />
        <span>{t('settings.codeCompletion.ignoreEos')}</span>
      </label>

      {!loaded && <p className={styles.hint}>{t('settings.codeCompletion.loading')}</p>}

      <div className={styles.actions}>
        <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
          {t('settings.codeCompletion.save')}
        </button>
        <button
          className={styles.testButton}
          data-testid="code-completion-test"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? t('settings.codeCompletion.testing') : t('settings.codeCompletion.test')}
        </button>
      </div>

      {testResult && (
        <div
          className={testResult.ok ? styles.testOk : styles.testFail}
          data-testid="code-completion-test-result"
        >
          <div>
            {testResult.ok
              ? t('settings.codeCompletion.testOk', { status: testResult.httpStatus })
              : t('settings.codeCompletion.testFail', { error: testResult.error ?? '' })}
          </div>
          {testResult.endpoint && <div className={styles.hint}>{testResult.endpoint}</div>}
          {testResult.snippet && <pre className={styles.snippet}>{testResult.snippet}</pre>}
        </div>
      )}
    </div>
  );
};

export default CodeCompletionSection;
```

在 `style.module.less` 追加：

```less
.actions {
  display: flex;
  gap: 8px;
}

.testButton {
  align-self: flex-start;
  padding: 6px 20px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #ccc);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.testButton:disabled {
  opacity: 0.6;
  cursor: default;
}

.testOk,
.testFail {
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
}

.testOk {
  background: rgba(60, 160, 90, 0.12);
}

.testFail {
  background: rgba(200, 60, 60, 0.12);
}

.snippet {
  margin: 6px 0 0;
  white-space: pre-wrap;
  font-family: monospace;
}
```

- [ ] **步骤 4：`global.d.ts` 增加回调声明**

紧跟 `updateCodeCompletionSettings` 之后加入：

```ts
  /**
   * Code completion "test connection" result from backend
   */
  onCodeCompletionTestResult?: (json: string) => void;
```

- [ ] **步骤 5：i18n 增补**

`en.json` 的 `settings.codeCompletion` 内加入：

```json
      "preset": "Platform",
      "path": "Endpoint path",
      "reusedFrom": "Using the API key from provider \"{{provider}}\"",
      "test": "Test connection",
      "testing": "Testing...",
      "testOk": "Success (HTTP {{status}})",
      "testFail": "Failed: {{error}}",
```

并把已存在的 `"model"` 值保持；同时删除不再使用的 `"source"`, `"sourceDeepseek"`, `"sourceCustom"`。

`zh.json` 对应：

```json
      "preset": "平台",
      "path": "接口路径",
      "reusedFrom": "已复用 provider「{{provider}}」的 API Key",
      "test": "测试连接",
      "testing": "测试中...",
      "testOk": "连接成功（HTTP {{status}}）",
      "testFail": "失败：{{error}}",
```

- [ ] **步骤 6：运行前端校验**

运行：`cd webview && npx tsc --noEmit && npx vitest run src/components/settings/CodeCompletionSection/index.test.tsx`
预期：tsc exit 0；5 个用例 PASS。

- [ ] **步骤 7：Commit（人工执行）**

```bash
git add webview/src/components/settings/CodeCompletionSection webview/src/global.d.ts \
        webview/src/i18n/locales/en.json webview/src/i18n/locales/zh.json
git commit -m "feat(completion): platform presets, endpoint path and test connection UI"
```

---

### 任务 7：整体验证与安装（用户执行）

- [ ] **步骤 1：后端全量相关测试**

运行：`./gradlew test --tests "com.github.claudecodegui.settings.*" --tests "com.github.claudecodegui.provider.common.*" --tests "com.github.claudecodegui.completion.*" -PskipWebview=true`
预期：BUILD SUCCESSFUL。

- [ ] **步骤 2：打包**

运行：`./gradlew buildPlugin`（webview 会自动重建）
预期：`build/distributions/idea-claude-code-gui-0.5.6.zip`

- [ ] **步骤 3：安装并重启 IDE**

沿用已验证的替换法（IDEA 运行中 jar 被锁，改名为非 `.jar` 后缀后放入新 jar）：

```powershell
$inst = "$env:APPDATA\JetBrains\IntelliJIdea2025.1\plugins\idea-claude-code-gui"
$zip  = "D:\code\jetbrains\jetbrains-cc-gui-v2\build\distributions\idea-claude-code-gui-0.5.6.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
$e = $z.GetEntry("idea-claude-code-gui/lib/idea-claude-code-gui-0.5.6.jar")
[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, "$env:TEMP\new.jar", $true)
$z.Dispose()
Rename-Item "$inst\lib\idea-claude-code-gui-0.5.6.jar" "$inst\lib\stale-$(Get-Date -Format yyyyMMddHHmmss).jar.stale"
Copy-Item "$env:TEMP\new.jar" "$inst\lib\idea-claude-code-gui-0.5.6.jar" -Force
Remove-Item "$inst\lib\*.jar.stale" -Force -ErrorAction SilentlyContinue
```

- [ ] **步骤 4：功能自测**

1. 设置 → 代码补全 → 平台选 **DeepSeek**（应自动填 `https://api.deepseek.com` + `/beta/completions` + `deepseek-flash`，并显示"已复用 provider ... 的 API Key"）→ 点 **测试连接** → 应显示 `Success (HTTP 200)` 与返回片段。
2. 平台切 **SiliconFlow**（自动填 `https://api.siliconflow.cn` + `/v1/completions`）→ 模型填 `deepseek-ai/DeepSeek-V3` → **测试连接** → 成功。
3. 故意把路径改成 `/nope` → **测试连接** → 应显示 `Failed: HTTP 404: ...`（验证"失败可见"）。
4. 恢复正确配置 → 启用 → 在 Java 文件 `{` 换行后按 `Ctrl+Space` → 出现 `DeepSeek FIM` 补全项 → Tab 接受。

---

## 自检记录

- **规格覆盖度**：§3 做(1) 平台预置→任务 1/6；做(2) path→任务 1/2/5/6；做(3) 测试连接→任务 4/6；做(4) 凭证复用→任务 3/4；做(5) 默认模型修正→任务 1。§6 超时 15s→任务 4；§7 编辑器侧→任务 5；§9 安全（key 掩码/截断/拒绝绝对 URL）→任务 1/2/4；§10 测试策略→任务 1/2/3/6。无遗漏。
- **占位符扫描**：无 TODO/待定；每个代码步骤均为完整代码。
- **类型一致性**：`CodeCompletionSettings.getPreset()/getPath()`（任务 1）在任务 3/4/5 中使用一致；`DeepSeekFimClient.HttpResult(status, body, error)`、`CallResult(ok, httpStatus, text, error, endpoint)`、`call(prefix, suffix, cfg, apiKey)`（任务 2）在任务 4/5 中调用一致；`CodeCompletionCredentialResolver.Resolution(apiKey, sourceName)` 与 `resolve(settings)`（任务 3）在任务 4/5 中一致；前端 `preset`/`path`/`onCodeCompletionTestResult`（任务 6）与后端 payload 字段一致。
