package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.*;

public class GrokLocalAuthResolverTest {

    @Test
    public void emptyAuthJsonIsNotAToken() {
        JsonObject empty = JsonParser.parseString("{}").getAsJsonObject();
        assertFalse(GrokLocalAuthResolver.credentialObjectHasToken(empty));
    }

    @Test
    public void accessTokenIsRecognized() {
        JsonObject obj = JsonParser.parseString("{\"access_token\":\"abc\"}").getAsJsonObject();
        assertTrue(GrokLocalAuthResolver.credentialObjectHasToken(obj));
    }

    @Test
    public void nestedAccessTokenIsRecognized() {
        JsonObject obj = JsonParser.parseString("{\"grok.com\":{\"access_token\":\"abc\"}}").getAsJsonObject();
        assertTrue(GrokLocalAuthResolver.credentialObjectHasToken(obj));
    }

    @Test
    public void parseConfigTomlDefaultProfile() {
        String toml = ""
                + "[models]\n"
                + "default = \"grok\"\n"
                + "\n"
                + "[model.grok]\n"
                + "model = \"grok-4.6\"\n"
                + "base_url = \"https://fufei.mossx.ai/v1\"\n"
                + "api_key = \"sk-test-from-config\"\n";
        GrokLocalAuthResolver.ConfigCredentials creds =
                GrokLocalAuthResolver.parseConfigTomlCredentials(toml);
        assertEquals("grok", creds.profile);
        assertEquals("sk-test-from-config", creds.apiKey);
        assertEquals("https://fufei.mossx.ai/v1", creds.baseUrl);
    }

    @Test
    public void parseConfigTomlQuotedProfile() {
        String toml = ""
                + "[models]\n"
                + "default = \"my grok\"\n"
                + "\n"
                + "[model.\"my grok\"]\n"
                + "api_key = \"sk-quoted\"\n"
                + "base_url = \"https://example.com/v1\"\n";
        GrokLocalAuthResolver.ConfigCredentials creds =
                GrokLocalAuthResolver.parseConfigTomlCredentials(toml);
        assertEquals("my grok", creds.profile);
        assertEquals("sk-quoted", creds.apiKey);
        assertEquals("https://example.com/v1", creds.baseUrl);
    }

    @Test
    public void resolveOauthWithTokenStaysOauth() {
        GrokLocalAuthResolver.ResolvedAuth r = GrokLocalAuthResolver.resolve(
                "oauth",
                "should-not-use",
                "",
                true,
                new GrokLocalAuthResolver.ConfigCredentials("cfg", "https://cfg", "grok")
        );
        assertEquals("oauth", r.authMethod);
        assertEquals("", r.apiKey);
        assertFalse(r.fellBackFromOauth);
        assertEquals("oauth-token", r.reason);
    }

    @Test
    public void resolveOauthEmptyFallsBackToConfigToml() {
        GrokLocalAuthResolver.ResolvedAuth r = GrokLocalAuthResolver.resolve(
                "oauth",
                "",
                "",
                false,
                new GrokLocalAuthResolver.ConfigCredentials(
                        "sk-from-toml",
                        "https://proxy.example/v1",
                        "grok"
                )
        );
        assertEquals("api_key", r.authMethod);
        assertEquals("sk-from-toml", r.apiKey);
        assertEquals("https://proxy.example/v1", r.baseUrl);
        assertTrue(r.fellBackFromOauth);
        assertEquals("oauth-empty-fallback-config-api-key", r.reason);
    }

    @Test
    public void resolveOauthEmptyPrefersPluginKey() {
        GrokLocalAuthResolver.ResolvedAuth r = GrokLocalAuthResolver.resolve(
                "oauth",
                "plugin-key",
                "https://plugin-base/v1",
                false,
                new GrokLocalAuthResolver.ConfigCredentials(
                        "sk-from-toml",
                        "https://proxy.example/v1",
                        "grok"
                )
        );
        assertEquals("api_key", r.authMethod);
        assertEquals("plugin-key", r.apiKey);
        assertEquals("https://plugin-base/v1", r.baseUrl);
        assertTrue(r.fellBackFromOauth);
        assertEquals("oauth-empty-fallback-plugin-api-key", r.reason);
    }

    @Test
    public void resolveOauthEmptyWithoutKeyStaysOauth() {
        GrokLocalAuthResolver.ResolvedAuth r = GrokLocalAuthResolver.resolve(
                "oauth",
                "",
                "",
                false,
                new GrokLocalAuthResolver.ConfigCredentials("", "", "")
        );
        assertEquals("oauth", r.authMethod);
        assertEquals("", r.apiKey);
        assertFalse(r.fellBackFromOauth);
        assertEquals("oauth-login-required", r.reason);
    }

    @Test
    public void resolveApiKeyModeFillsFromConfigWhenEmpty() {
        GrokLocalAuthResolver.ResolvedAuth r = GrokLocalAuthResolver.resolve(
                "api_key",
                "",
                "",
                false,
                new GrokLocalAuthResolver.ConfigCredentials("sk-cfg", "https://cfg/v1", "g")
        );
        assertEquals("api_key", r.authMethod);
        assertEquals("sk-cfg", r.apiKey);
        assertEquals("https://cfg/v1", r.baseUrl);
        assertEquals("api_key-from-config", r.reason);
    }
}
