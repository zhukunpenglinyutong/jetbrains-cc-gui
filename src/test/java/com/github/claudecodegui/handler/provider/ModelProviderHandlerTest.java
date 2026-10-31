package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.ClaudeContextWindowOverrideProvider;
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

    /**
     * The bridge only falls back to ANTHROPIC_MODEL inside a family branch; a
     * {@code claude-*} id without a family name is sent unchanged.
     */
    @Test
    public void shouldNotApplyMainModelToClaudeIdsWithoutFamily() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_MODEL", "glm-4.7");

        assertEquals("claude-custom-x", ModelProviderHandler.resolveConfiguredClaudeModel("claude-custom-x", env));
        assertEquals("claude-custom-x[1M]",
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-custom-x[1M]", env));
    }

    /**
     * The request owns the 1M choice, matching {@code resolveModelFromSettings}
     * in ai-bridge: a suffix stored on the mapping value must not turn on 1M when
     * the user did not ask for it.
     */
    @Test
    public void shouldLetRequestOwnTheCapacitySuffixLikeTheBridge() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "glm-4.7[1M]");

        String without1M = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6", env);
        String with1M = ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-4-6[1m]", env);

        assertEquals("glm-4.7", without1M);
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit(without1M));
        assertEquals("glm-4.7[1m]", with1M);
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit(with1M));
    }

    /**
     * A family mapping replaces the model name, not the UI's 1M choice. The bridge
     * sends {@code <mapped>[1m]} to the CLI, so the Java window calculation must
     * keep the suffix too.
     */
    @Test
    public void shouldPreserveRequested1MSuffixWhenResolvingMappedModel() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4.1-flash");

        assertEquals("deepseek-v4.1-flash[1m]",
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5[1m]", env));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit(
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5[1m]", env)));
        assertEquals("deepseek-v4.1-flash",
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5", env));
    }

    @Test
    public void shouldNormalizeExisting1MSuffixFromMapping() {
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_DEFAULT_SONNET_MODEL", "deepseek-v4-pro[1M]");

        // The mapped suffix is stripped and re-appended in the bridge's canonical
        // lowercase form, so it is never duplicated.
        assertEquals("deepseek-v4-pro[1m]",
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5[1m]", env));
        assertEquals("deepseek-v4-pro",
                ModelProviderHandler.resolveConfiguredClaudeModel("claude-sonnet-5", env));
    }

    @Test
    public void shouldKeepExpectedContextLimitsForVisibleCodexModels() {
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.3-codex"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gpt-5.4"));
        assertEquals(258_000, ModelProviderHandler.getModelContextLimit("gpt-5.2-codex"));
        // GPT-6 Sol / Luna are the 1.05M-context successors of the GPT-5.6 entries.
        assertEquals(1_050_000, ModelProviderHandler.getModelContextLimit("gpt-6.1-sol"));
        assertEquals(1_050_000, ModelProviderHandler.getModelContextLimit("gpt-6-sol"));
        assertEquals(1_050_000, ModelProviderHandler.getModelContextLimit("gpt-6-luna"));
    }

    @Test
    public void shouldReturnCorrectContextLimitsForClaudeModels() {
        // Base IDs without [1m] suffix - 200k context by default
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5-5[1m]"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-opus-5[1m]"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5-5[1m]"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5"));
        assertTrue(ModelProviderHandler.MODEL_CONTEXT_LIMITS.containsKey("claude-sonnet-5[1m]"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-5-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-fable-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-7"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-8"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6"));
        // IDs with [1m] suffix - 1M context
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-5-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-opus-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-fable-5[1m]"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-5-5[1m]"));
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

    /**
     * The CLI reports {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} in /context, so the
     * input-box indicator must resolve the same override instead of using the
     * 200k fallback for unknown custom models.
     */
    @Test
    public void shouldPreferClaudeMaxContextTokensOverrideFromSettings() throws Exception {
        Path settings = Files.createTempFile("claude-settings", ".json");
        Files.writeString(settings, """
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "512000"
                  }
                }
                """);
        ClaudeContextWindowOverrideProvider.setInstanceForTests(
                ClaudeContextWindowOverrideProvider.createForTests(settings)
        );

        try {
            assertEquals(512_000,
                    ModelProviderHandler.getClaudeContextLimit("deepseek-v4.1-flash", null));
            assertEquals(512_000,
                    ModelProviderHandler.resolveContextLimit("claude", "deepseek-v4.1-flash", null));
            // The UI's [1m] choice is per-model and wins over a smaller global override.
            assertEquals(1_000_000,
                    ModelProviderHandler.getClaudeContextLimit("deepseek-v4.1-flash[1m]", null));
            assertEquals(500_000,
                    ModelProviderHandler.getClaudeContextLimit("deepseek-v4.1-flash[500k]", null));
        } finally {
            ClaudeContextWindowOverrideProvider.setInstanceForTests(null);
        }
    }

    /**
     * The CLI keeps a recognized Claude model's own window and only applies
     * CLAUDE_CODE_MAX_CONTEXT_TOKENS to ids it does not know.
     */
    @Test
    public void shouldIgnoreOverrideForClaudeModelIds() throws Exception {
        withSettings("""
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000"
                  }
                }
                """, () -> {
            assertEquals(200_000, ModelProviderHandler.getClaudeContextLimit("claude-haiku-4-5", null));
            assertEquals(1_000_000, ModelProviderHandler.getClaudeContextLimit("claude-sonnet-5[1m]", null));
            assertEquals(200_000, ModelProviderHandler.resolveContextLimit("claude", "claude-haiku-4-5", null));
            assertEquals(128_000, ModelProviderHandler.getClaudeContextLimit("kimi-k3", null));
        });
    }

    /**
     * A [1m] opt-in is a floor: the CLI reports max(override, 1M) for an unknown model.
     */
    @Test
    public void shouldKeepLargerOverrideForOneMillionOptIn() throws Exception {
        withSettings("""
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "2000000"
                  }
                }
                """, () -> assertEquals(2_000_000,
                ModelProviderHandler.getClaudeContextLimit("deepseek-v4-pro[1m]", null)));
    }

    /**
     * With auto-compact disabled the CLI uses the override for every model, even over [1m].
     */
    @Test
    public void shouldApplyOverrideToEveryModelWhenCompactIsDisabled() throws Exception {
        withSettings("""
                {
                  "env": {
                    "DISABLE_COMPACT": "1",
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000"
                  }
                }
                """, () -> {
            assertEquals(128_000, ModelProviderHandler.getClaudeContextLimit("claude-haiku-4-5", null));
            assertEquals(128_000, ModelProviderHandler.getClaudeContextLimit("deepseek-v4-pro[1m]", null));
        });
    }

    /**
     * Usage fallbacks receive the UI slot id. The family mapping must be applied
     * first so the override is checked against the model the CLI actually gets.
     */
    @Test
    public void resolveContextLimitAppliesFamilyMappingBeforeOverride() throws Exception {
        withSettings("""
                {
                  "env": {
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k3",
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "262144"
                  }
                }
                """, () -> {
            assertEquals(262_144, ModelProviderHandler.resolveContextLimit("claude", "claude-sonnet-5", null));
            // Haiku is not mapped, so the CLI receives a Claude id and keeps its own window.
            assertEquals(200_000, ModelProviderHandler.resolveContextLimit("claude", "claude-haiku-4-5", null));
        });
    }

    @Test
    public void shouldReadOverrideFromProjectSettingsOfSessionCwd() throws Exception {
        Path project = Files.createTempDirectory("claude-project");
        Files.createDirectories(project.resolve(".claude"));
        Files.writeString(project.resolve(".claude").resolve("settings.local.json"), """
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "384000"
                  }
                }
                """);

        withSettings("{}", () -> {
            assertEquals(384_000, ModelProviderHandler.getClaudeContextLimit("kimi-k3", project.toString()));
            assertEquals(200_000, ModelProviderHandler.getClaudeContextLimit("kimi-k3", null));
        });
    }

    private static void withSettings(String json, Runnable assertions) throws Exception {
        Path settings = Files.createTempFile("claude-settings", ".json");
        Files.writeString(settings, json);
        ClaudeContextWindowOverrideProvider.setInstanceForTests(
                ClaudeContextWindowOverrideProvider.createForTests(settings)
        );
        try {
            assertions.run();
        } finally {
            ClaudeContextWindowOverrideProvider.setInstanceForTests(null);
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

    /**
     * Switching models inside the Claude provider keeps the transcript, so the
     * current context snapshot stays valid; only the capacity denominator changes.
     */
    @Test
    public void handleSetModelKeepsClaudeContextUsageWhenSwitchingModel() {
        HandlerContext context = createHandlerContext();
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("claude");
        session.setModel("deepseek-v4.1-flash");
        JsonObject raw = new JsonObject();
        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", 37800);
        usage.addProperty("cache_read_input_tokens", 1200);
        raw.add("usage", usage);
        session.getState().addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "restored", raw));
        context.setSession(session);
        context.setCurrentProvider("claude");
        context.setCurrentModel("deepseek-v4.1-flash");
        RecordingUsagePushService usagePushService = new RecordingUsagePushService(context);

        new ModelProviderHandler(context, usagePushService).handleSetModel("deepseek-v4.1-pro");

        assertTrue(raw.has("usage"));
        assertFalse(usagePushService.cleared);
        assertTrue(usagePushService.recalculated);
    }

    /**
     * Codex snapshots embed the previous model's model_context_window, so they
     * still have to be dropped when the selected model changes.
     */
    @Test
    public void handleSetModelClearsCodexContextUsageWhenSwitchingModel() {
        HandlerContext context = createHandlerContext();
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setModel("gpt-5.3-codex");
        JsonObject raw = new JsonObject();
        raw.add("usage", createUsage(49300, 258400));
        session.getState().addMessage(new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "restored", raw));
        context.setSession(session);
        context.setCurrentProvider("codex");
        context.setCurrentModel("gpt-5.3-codex");
        RecordingUsagePushService usagePushService = new RecordingUsagePushService(context);

        new ModelProviderHandler(context, usagePushService).handleSetModel("gpt-5.6-sol");

        assertFalse(raw.has("usage"));
        assertTrue(usagePushService.cleared);
        assertTrue(usagePushService.recalculated);
    }

    /**
     * Non-Claude providers keep their pre-PR behavior: a model switch drops the
     * provider-specific snapshot and the denominator stays on the static table.
     * CLAUDE_CODE_MAX_CONTEXT_TOKENS is a Claude-only override.
     */
    @Test
    public void handleSetModelClearsGrokContextUsageAndIgnoresClaudeOverride() throws Exception {
        Path settings = Files.createTempFile("claude-settings", ".json");
        Files.writeString(settings, """
                {
                  "env": {
                    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "128000"
                  }
                }
                """);
        ClaudeContextWindowOverrideProvider.setInstanceForTests(
                ClaudeContextWindowOverrideProvider.createForTests(settings)
        );

        try {
            HandlerContext context = createHandlerContext();
            ClaudeSession session = new ClaudeSession(null, null, null, null);
            session.setProvider("grok");
            session.setModel("grok-4");
            JsonObject raw = new JsonObject();
            JsonObject usage = new JsonObject();
            usage.addProperty("input_tokens", 1000);
            usage.addProperty("output_tokens", 500);
            usage.addProperty("cached_read_tokens", 30000);
            raw.add("usage", usage);
            session.getState().addMessage(new ClaudeSession.Message(
                    ClaudeSession.Message.Type.ASSISTANT, "restored", raw));
            context.setSession(session);
            context.setCurrentProvider("grok");
            context.setCurrentModel("grok-4");
            RecordingUsagePushService usagePushService = new RecordingUsagePushService(context);

            new ModelProviderHandler(context, usagePushService).handleSetModel("grok-build");

            assertFalse(raw.has("usage"));
            assertTrue(usagePushService.cleared);
            assertTrue(usagePushService.recalculated);
            assertEquals(500_000, usagePushService.lastMaxTokens);
        } finally {
            ClaudeContextWindowOverrideProvider.setInstanceForTests(null);
        }
    }

    /**
     * A set_model from the webview is an explicit user choice. A custom model id
     * that is also in the retired-migration table must reach the session verbatim
     * instead of being rewritten to its replacement (custom opus-4-8 -> opus-5).
     */
    @Test
    public void handleSetModelStoresCustomRetiredIdVerbatim() {
        HandlerContext context = createHandlerContext();
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("claude");
        context.setSession(session);
        context.setCurrentProvider("claude");
        RecordingUsagePushService usagePushService = new RecordingUsagePushService(context);

        new ModelProviderHandler(context, usagePushService).handleSetModel("claude-opus-4-8[1m]");

        assertEquals("claude-opus-4-8[1m]", context.getCurrentModel());
        assertEquals("claude-opus-4-8[1m]", session.getModel());
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
        private int lastMaxTokens = -1;

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
            lastMaxTokens = newMaxTokens;
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
