package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Mirrors vscode-cc-gui claudeSettingsSync.test.mts.
 */
public class ClaudeSettingsSyncPlanTest {
    @Test
    public void switchingManagedProviderReplacesPickerAndAllRoleNames() {
        JsonObject current = new JsonObject();
        JsonObject oldPicker = new JsonObject();
        oldPicker.addProperty("replaceBuiltInOptions", true);
        current.add("modelPicker", oldPicker);
        current.addProperty("customSetting", "keep");
        JsonObject oldEnv = new JsonObject();
        for (String role : new String[]{"HAIKU", "SONNET", "OPUS", "FABLE"}) {
            oldEnv.addProperty("ANTHROPIC_DEFAULT_" + role + "_MODEL_NAME", "old");
        }
        oldEnv.addProperty("CUSTOM_ENV", "keep");
        current.add("env", oldEnv);
        JsonObject active = new JsonObject();
        active.addProperty("id", "managed-direct");
        JsonObject config = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "glm-pro");
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "New name");
        config.add("env", env);
        active.add("settingsConfig", config);
        JsonObject next = ClaudeSettingsSyncPlan.plan(current, active).nextSettings;
        assertTrue(!next.has("modelPicker"));
        assertEquals("keep", next.get("customSetting").getAsString());
        assertEquals("keep", next.getAsJsonObject("env").get("CUSTOM_ENV").getAsString());
        assertEquals("New name", next.getAsJsonObject("env").get("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME").getAsString());
        for (String role : new String[]{"HAIKU", "OPUS", "FABLE"}) {
            assertTrue(!next.getAsJsonObject("env").has("ANTHROPIC_DEFAULT_" + role + "_MODEL_NAME"));
        }
        assertTrue(current.has("modelPicker"));
        assertEquals("old", oldEnv.get("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME").getAsString());
        JsonObject replacement = new JsonObject();
        replacement.addProperty("replaceBuiltInOptions", false);
        config.add("modelPicker", replacement);
        assertEquals(replacement, ClaudeSettingsSyncPlan.plan(current, active).nextSettings.get("modelPicker"));
        active.addProperty("id", ProviderManager.LOCAL_SETTINGS_PROVIDER_ID);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, ClaudeSettingsSyncPlan.plan(current, active).action);
        assertEquals(oldPicker, current.get("modelPicker"));
    }


    @Test
    public void skipsLocalSettingsMode() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", ProviderManager.LOCAL_SETTINGS_PROVIDER_ID);
        active.addProperty("isActive", true);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("no-managed-provider", d.reason);
    }

    @Test
    public void skipsWhenNoProviderActive() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        env.addProperty("ANTHROPIC_BASE_URL", "https://example.test");
        current.add("env", env);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, null);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("no-managed-provider", d.reason);
    }

    @Test
    public void skipsManagedProviderWithEmptyEnvPayload() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "keep-me");
        current.add("env", env);
        current.addProperty("model", "claude-opus-4-8");

        JsonObject active = new JsonObject();
        active.addProperty("id", "proxy-a");
        active.addProperty("isActive", true);
        JsonObject settingsConfig = new JsonObject();
        settingsConfig.addProperty("model", "claude-opus-4-8");
        // no env
        active.add("settingsConfig", settingsConfig);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertEquals("empty-env-payload", d.reason);
    }

    @Test
    public void writesEnvWhilePreservingCustomKeys() {
        JsonObject current = new JsonObject();
        current.addProperty("model", "claude-opus-4-8");
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "old");
        env.addProperty("ANTHROPIC_BASE_URL", "https://old.test");
        env.addProperty("CUSTOM_KEEP", "1");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", "proxy-b");
        active.addProperty("isActive", true);
        JsonObject settingsConfig = new JsonObject();
        JsonObject newEnv = new JsonObject();
        newEnv.addProperty("ANTHROPIC_AUTH_TOKEN", "new");
        newEnv.addProperty("ANTHROPIC_BASE_URL", "https://new.test");
        settingsConfig.add("env", newEnv);
        active.add("settingsConfig", settingsConfig);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.WRITE, d.action);
        assertNotNull(d.nextSettings);
        JsonObject outEnv = d.nextSettings.getAsJsonObject("env");
        assertEquals("new", outEnv.get("ANTHROPIC_AUTH_TOKEN").getAsString());
        assertEquals("https://new.test", outEnv.get("ANTHROPIC_BASE_URL").getAsString());
        assertEquals("1", outEnv.get("CUSTOM_KEEP").getAsString());
        assertEquals("claude-opus-4-8", d.nextSettings.get("model").getAsString());
        assertEquals("proxy-b", d.nextSettings.get("codemossProviderId").getAsString());
    }

    @Test
    public void skipsCliLoginSettingsWrite() {
        JsonObject current = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "old");
        current.add("env", env);

        JsonObject active = new JsonObject();
        active.addProperty("id", ProviderManager.CLI_LOGIN_PROVIDER_ID);
        active.addProperty("isActive", true);

        ClaudeSettingsSyncPlan.Decision d = ClaudeSettingsSyncPlan.plan(current, active);
        assertEquals(ClaudeSettingsSyncPlan.Action.SKIP, d.action);
        assertTrue(d.reason.contains("cli-login"));
        assertNull(d.nextSettings);
    }
}
