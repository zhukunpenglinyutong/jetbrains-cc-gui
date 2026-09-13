package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.CustomModelContextWindowProvider;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for Claude model resolution in {@link ModelProviderHandler}.
 */
public class ModelProviderHandlerTest {

    @Test
    public void shouldUseMainModelAsFallbackWhenFamilyMappingIsMissing() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "glm-4.7");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-opus-4-6", env);

        assertEquals("glm-4.7", resolved);
    }

    @Test
    public void shouldPreferFamilySpecificMappingOverMainModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "deepseek-v4-pro");
        env.addProperty("ANTHROPIC_DEFAULT_FABLE_MODEL", "glm-5.2");
        env.addProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", "deepseek-v4-flash");
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-flash");

        String fable = ModelProviderHandler.resolveConfiguredClaudeModel("claude-fable-5", env);
        String haiku = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);
        String sonnet = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6", env);

        assertEquals("glm-5.2", fable);
        assertEquals("deepseek-v4-flash", haiku);
        assertEquals("deepseek-v4-flash", sonnet);
    }

    @Test
    public void shouldUseFamilySpecificMappingForSelectedClaudeModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku-proxy");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);

        assertEquals("haiku-proxy", resolved);
    }

    @Test
    public void shouldIgnoreSmallFastModelForHaikuResolution() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_SMALL_FAST_MODEL", "legacy-haiku-proxy");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-haiku-4-5", env);

        assertEquals("claude-haiku-4-5", resolved);
    }

    @Test
    public void shouldNotApplySonnetMappingToAlreadyCustomModelIds() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("deepseek-v3", env);

        assertEquals("deepseek-v3", resolved);
    }

    @Test
    public void shouldUseResolvedModelForContextLimitWhenCapacitySuffixExists() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7[1M]");

        String resolved = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6", env);

        assertEquals("glm-4.7[1M]", resolved);
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit(resolved));
    }

    @Test
    public void shouldKeepExpectedContextLimitsForVisibleCodexModels() {
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.3-codex"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gpt-5.4"));
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.2-codex"));
    }

    @Test
    public void shouldReturnCorrectContextLimitsForClaudeModels() {
        // Base IDs without [1m] suffix - 200k context by default
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5[1m]"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5[1m]"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-fable-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-7"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-8"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6"));
        // IDs with [1m] suffix - 1M context
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-fable-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-7[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-8[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6[1m]"));
        // Haiku - no 1M context available
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-haiku-4-5"));
    }

    @Test
    public void shouldParseCapacitySuffixForCustomContextLimits() {
        assertEquals(500_000, ModelProviderHandler.getModelContextLimit("custom-model[500k]"));
        assertEquals(2_000_000, ModelProviderHandler.getModelContextLimit("custom-model[2m]"));
        assertEquals(100_000, ModelProviderHandler.getModelContextLimit("custom-model[100K]"));
    }

    @Test
    public void shouldPreferConfiguredCustomContextAndKeepExistingFallbacks() throws Exception {
        Path config = Files.createTempFile("model-context-limit", ".json");
        Files.writeString(config, """
                {
                  "customModelContextWindows": {
                    "codex": {
                      "custom-model": 750000
                    }
                  }
                }
                """);
        CustomModelContextWindowProvider.setInstanceForTests(
                CustomModelContextWindowProvider.createForTests(config)
        );

        try {
            assertEquals(750_000, ModelProviderHandler.getModelContextLimit("codex", "custom-model"));
            assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("codex", "custom-model[1m]"));
            assertEquals(500_000, ModelProviderHandler.getModelContextLimit("codex", "legacy-model[500k]"));
            assertEquals(200_000, ModelProviderHandler.getModelContextLimit("codex", "unknown-model"));
        } finally {
            CustomModelContextWindowProvider.setInstanceForTests(null);
        }
    }

    @Test
    public void shouldIgnoreConfiguredCustomContextForClaude() throws Exception {
        Path config = Files.createTempFile("model-context-limit", ".json");
        Files.writeString(config, """
                {
                  "customModelContextWindows": {
                    "claude": {
                      "custom-claude": 750000
                    }
                  }
                }
                """);
        CustomModelContextWindowProvider.setInstanceForTests(
                CustomModelContextWindowProvider.createForTests(config)
        );

        try {
            assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude", "custom-claude"));
            assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude", "custom-claude[1m]"));
        } finally {
            CustomModelContextWindowProvider.setInstanceForTests(null);
        }
    }

    /**
     * Verifies only a real cross-provider transition invalidates provider-owned context usage.
     */
    @Test
    public void shouldDetectOnlyActualProviderSwitches() {
        assertTrue(ModelProviderHandler.isActualProviderSwitch("claude", "codex"));
        assertFalse(ModelProviderHandler.isActualProviderSwitch("codex", "codex"));
        assertFalse(ModelProviderHandler.isActualProviderSwitch(null, "codex"));
        assertFalse(ModelProviderHandler.isActualProviderSwitch("", "codex"));
    }

    /**
     * Verifies same-model reaffirmation remains a no-op so dynamic context capacity is retained.
     */
    @Test
    public void shouldDetectOnlyActualModelSwitches() {
        assertTrue(ModelProviderHandler.isActualModelSwitch("gpt-5.3-codex", "gpt-5.6-sol"));
        assertFalse(ModelProviderHandler.isActualModelSwitch("gpt-5.6-sol", "gpt-5.6-sol"));
        assertFalse(ModelProviderHandler.isActualModelSwitch(null, "gpt-5.6-sol"));
        assertFalse(ModelProviderHandler.isActualModelSwitch("", "gpt-5.6-sol"));
    }

    /**
     * Verifies startup model synchronization treats the restored Session model as
     * authoritative when HandlerContext still contains its default, preserving the
     * usage snapshot for a same-value frontend set_model command.
     */
    @Test
    public void handleSetModelPreservesUsageWhenRestoredSessionAlreadyOwnsModel() {
        HandlerContext context = createHandlerContext();
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setModel("gpt-5.6-sol");
        JsonObject raw = new JsonObject();
        raw.add("usage", createUsage(49300, 258400));
        session.getState().addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "restored", raw));
        context.setSession(session);
        context.setCurrentProvider("codex");
        context.setCurrentModel(HandlerContext.DEFAULT_MODEL);
        RecordingUsagePushService usagePushService = new RecordingUsagePushService(context);

        new ModelProviderHandler(context, usagePushService).handleSetModel("gpt-5.6-sol");

        assertEquals("gpt-5.6-sol", context.getCurrentModel());
        assertTrue(raw.has("usage"));
        assertFalse(usagePushService.cleared);
        assertFalse(usagePushService.recalculated);
    }

    private static HandlerContext createHandlerContext() {
        return new HandlerContext(null, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                // No-op callback for handler state tests.
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static JsonObject createUsage(int inputTokens, int contextWindow) {
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", inputTokens);
        usage.addProperty("output_tokens", 0);
        usage.addProperty("model_context_window", contextWindow);
        return usage;
    }

    /**
     * Records whether a model command attempted to invalidate or recalculate usage.
     */
    private static final class RecordingUsagePushService extends UsagePushService {
        private boolean cleared;
        private boolean recalculated;

        private RecordingUsagePushService(HandlerContext context) {
            super(context);
        }

        @Override
        public void clearUsageDisplay() {
            cleared = true;
        }

        @Override
        public void pushUsageUpdateAfterModelChange(int newMaxTokens) {
            recalculated = true;
        }
    }

    // ============================================================================
    // Provider transition matrix — see L2 in NODE_PROCESS_LEAK_FIX_TASKS.md.
    // The Claude daemon must be torn down when (and ONLY when) the tab leaves
    // the Claude family. These tests pin the full matrix.
    // ============================================================================

    @Test
    public void shouldShutdownDaemonWhenSwitchingFromClaudeToCodex() {
        // The bug: switching to Codex previously left the Claude daemon alive,
        // causing it to accumulate as a phantom process across the tab lifetime.
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "codex"));
    }

    @Test
    public void shouldNotShutdownDaemonWhenSwitchingFromCodexToClaude() {
        // Returning to Claude must NOT shut down the daemon — the next message
        // will lazily start a fresh one if needed.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("codex", "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnClaudeToClaudeReaffirmation() {
        // useMessageSender re-fires set_provider("claude") on every message send.
        // We must never tear down the warm daemon on these no-op transitions.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnCodexToCodexReaffirmation() {
        // Same protection on the Codex side — there's no Claude daemon to kill
        // here, but the predicate must still return false so we don't log noise.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("codex", "codex"));
    }

    @Test
    public void shouldNotShutdownDaemonOnNullPreviousProvider() {
        // Initial startup may surface a null previous provider; nothing to clean up yet.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch(null, "codex"));
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch(null, "claude"));
    }

    @Test
    public void shouldNotShutdownDaemonOnNullNewProvider() {
        // Defensive: a null new provider should not be treated as a leave-claude transition.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", null));
    }

    @Test
    public void shouldShutdownDaemonWhenSwitchingFromClaudeToUnknownProvider() {
        // Future-proof: any non-claude target after Claude qualifies as leave-claude.
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "gemini"));
    }

    @Test
    public void shouldNotShutdownDaemonOnEmptyNewProvider() {
        // Empty string is not a valid "leave claude" transition — it usually
        // signals an init race. The predicate must treat it the same as null
        // to avoid spurious 5–10s daemon restarts.
        assertFalse(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", ""));
    }
}
