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
        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {provider("DS", "https://api.deepseek.com", "sk-stored")});
        assertEquals("sk-explicit", r.apiKey);
        assertEquals("", r.sourceName);
    }

    @Test
    public void reusesProviderKeyByHost() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.deepseek.com");
        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {provider("DeepSeek-V4-Pro", "https://api.deepseek.com/anthropic", "sk-a0")});
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
        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {p});
        assertEquals("sk-env", r.apiKey);
        assertEquals("SiliconFlow", r.sourceName);
    }

    @Test
    public void noMatchYieldsEmptyKey() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://unknown.example.com");
        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {provider("X", "https://other.com", "sk-x")});
        assertEquals("", r.apiKey);
        assertEquals("", r.sourceName);
    }

    // The plugin's own provider editor writes the endpoint and token into
    // settingsConfig.env, with no top-level baseUrl/apiKey at all — the shape the
    // resolver used to miss entirely.
    @Test
    public void reusesAProviderTheUiCreated() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://ark.cn-beijing.volces.com/api/coding");
        JsonObject p = new JsonObject();
        p.addProperty("name", "DouBaoSeed");
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_BASE_URL", "https://ark.cn-beijing.volces.com/api/coding");
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "sk-from-env");
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.add("env", env);
        p.add("settingsConfig", settingsConfig);

        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {p});
        assertEquals("sk-from-env", r.apiKey);
        assertEquals("DouBaoSeed", r.sourceName);
    }

    // Codex providers keep everything as text: `configToml` holds base_url and
    // `authJson` holds the key.
    @Test
    public void reusesACodexProvider() {
        CodeCompletionSettings s = new CodeCompletionSettings();
        s.setBaseUrl("https://api.siliconflow.cn");
        JsonObject p = new JsonObject();
        p.addProperty("name", "SiliconFlow (codex)");
        p.addProperty("configToml", "[model_providers.siliconflow]\nbase_url = \"https://api.siliconflow.cn/v1\"\n");
        p.addProperty("authJson", "{\"OPENAI_API_KEY\":\"sk-codex\"}");

        CodeCompletionCredentialResolver.Resolution r = CodeCompletionCredentialResolver.pick(
                s, new JsonObject[] {p});
        assertEquals("sk-codex", r.apiKey);
        assertEquals("SiliconFlow (codex)", r.sourceName);
    }

    @Test
    public void doesNotMatchTheReverseSubdomain() {
        // A provider for deepseek.com must not lend its key to api.deepseek.com.
        assertFalse(CodeCompletionCredentialResolver.sameHost("https://deepseek.com", "https://api.deepseek.com"));
        assertTrue(CodeCompletionCredentialResolver.sameHost("https://api.deepseek.com", "https://deepseek.com"));
    }

    @Test
    public void twoExplicitPortsAreTwoServices() {
        assertFalse(CodeCompletionCredentialResolver.sameHost(
                "http://127.0.0.1:8317", "http://127.0.0.1:8000"));
        assertTrue(CodeCompletionCredentialResolver.sameHost(
                "http://127.0.0.1:8317", "http://127.0.0.1:8317/v1"));
        // A port on only one side still matches (implicit default port).
        assertTrue(CodeCompletionCredentialResolver.sameHost(
                "https://api.deepseek.com", "https://api.deepseek.com:443"));
    }
}
