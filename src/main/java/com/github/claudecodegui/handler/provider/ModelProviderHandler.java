package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.session.SessionSendService;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.skill.SlashCommandRegistry;
import com.github.claudecodegui.provider.ClaudeContextWindowOverrideProvider;
import com.github.claudecodegui.provider.CustomModelContextWindowProvider;
import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Handles model and provider selection, reasoning effort, and slash command refresh.
 */
public class ModelProviderHandler {

    private static final Logger LOG = Logger.getInstance(ModelProviderHandler.class);

    private static final Pattern CAPACITY_SUFFIX_PATTERN =
            Pattern.compile("\\s*\\[([0-9.]+)([kKmM])\\]\\s*$");
    private static final Pattern ONE_MILLION_SUFFIX_PATTERN =
            Pattern.compile("(?i)\\[1m\\]\\s*$");

    static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new HashMap<>();
    static {
        // Claude models with 1M context (base IDs)
        MODEL_CONTEXT_LIMITS.put("claude-fable-5-1", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-5-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-5-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-7", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-6", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-fable-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-8", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-6", 200_000);
        // Claude models with [1m] suffix - 1M context
        MODEL_CONTEXT_LIMITS.put("claude-fable-5-1[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-5-5[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-5[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-5-5[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-5[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-7[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-6[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-fable-5[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-8[1m]", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-6[1m]", 1_000_000);
        // Haiku - no 1M context available
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
        // Codex/GPT models
        MODEL_CONTEXT_LIMITS.put("gpt-6-astra", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-6.1-sol", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-6-sol", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.6-sol", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.6-terra", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-6-luna", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.6-luna", 1_050_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.4", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.4-mini", 400_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.3-codex", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.2-codex", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.2", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4-turbo", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4", 8_192);
        MODEL_CONTEXT_LIMITS.put("o3", 200_000);
        MODEL_CONTEXT_LIMITS.put("o3-mini", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("o1-preview", 128_000);

        // Grok models (xAI)
        MODEL_CONTEXT_LIMITS.put("grok-2", 128_000);
        MODEL_CONTEXT_LIMITS.put("grok-2-latest", 128_000);
        MODEL_CONTEXT_LIMITS.put("grok-beta", 128_000);
        MODEL_CONTEXT_LIMITS.put("grok", 500_000);
        MODEL_CONTEXT_LIMITS.put("grok-1.5", 128_000);
        MODEL_CONTEXT_LIMITS.put("grok-4.6", 500_000);
        MODEL_CONTEXT_LIMITS.put("grok-4.5", 500_000); // legacy alias
        MODEL_CONTEXT_LIMITS.put("grok-4", 500_000);
        MODEL_CONTEXT_LIMITS.put("grok-build", 500_000);
        // ZCode models (GLM)
        MODEL_CONTEXT_LIMITS.put("GLM-5.3", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("GLM-5.3-Flash", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("GLM-5-Turbo", 200_000);
    }

    private final HandlerContext context;
    private final UsagePushService usagePushService;
    private final Gson gson = new Gson();

    public ModelProviderHandler(HandlerContext context, UsagePushService usagePushService) {
        this.context = context;
        this.usagePushService = usagePushService;
    }

    public void handleSetModel(String content) {
        try {
            String model = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("model")) {
                        model = json.get("model").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the model
                }
            }

            String previousModel = resolveCurrentSessionModel(context);
            boolean modelChanged = isActualModelSwitch(previousModel, model);
            LOG.info("[ModelProviderHandler] Setting model to: " + model
                    + " (was: " + previousModel + ")");
            context.setCurrentModel(model);

            String provider = context.getCurrentProvider();
            boolean isClaude = "claude".equalsIgnoreCase(provider);

            if (context.getSession() != null) {
                // Explicit user pick from the webview: store verbatim so a custom
                // model id is never rewritten by the retired-model migration.
                context.getSession().setModelVerbatim(model);
                // Claude snapshots only carry token counts and the transcript is
                // unchanged, so the current context survives the switch and only
                // the capacity denominator needs recalculation. Every other
                // provider embeds provider-specific context metadata in its
                // snapshot (Codex model_context_window, Grok cached_read_tokens,
                // ...), so the stale snapshot must be dropped.
                if (modelChanged && !isClaude) {
                    clearSessionUsage();
                }
                LOG.info("[ModelProviderHandler] Updated session model to canonical ID: " + model);
            }

            if (modelChanged && !isClaude) {
                usagePushService.clearUsageDisplay();
            }

            if (context.getProject() != null) {
                com.github.claudecodegui.notifications.ClaudeNotifier.setModel(context.getProject(), model);
            }

            String resolvedModelForUsage = isClaude
                    ? resolveConfiguredClaudeModelFromSettings(model)
                    : model;
            int newMaxTokens = isClaude
                    ? getClaudeContextLimit(resolvedModelForUsage, sessionCwd(context))
                    : getModelContextLimit(provider, model);
            LOG.info("[ModelProviderHandler] Model context limit: " + newMaxTokens
                    + " tokens for selected model: " + model
                    + ", resolved model: " + resolvedModelForUsage);

            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            Runnable confirmModel = () -> {
                context.callJavaScript("window.onModelConfirmed", context.escapeJs(confirmedModel), context.escapeJs(confirmedProvider));
                if (modelChanged) {
                    usagePushService.pushUsageUpdateAfterModelChange(newMaxTokens);
                }
            };
            if (ApplicationManager.getApplication() != null) {
                ApplicationManager.getApplication().invokeLater(confirmModel);
            } else {
                // Plain unit tests have no IntelliJ Application; keep the state
                // transition testable without changing the IDE's EDT behavior.
                confirmModel.run();
            }
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set model: " + e.getMessage(), e);
        }
    }

    public void handleSetProvider(String content) {
        try {
            String provider = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("provider")) {
                        provider = json.get("provider").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the provider
                }
            }

            // Capture previous provider BEFORE mutating context so we can detect
            // the leave-claude transition that needs daemon cleanup.
            String previousProvider = context.getCurrentProvider();
            boolean providerChanged = isActualProviderSwitch(previousProvider, provider);
            LOG.info("[ModelProviderHandler] Setting provider to: " + provider
                    + " (was: " + previousProvider + ")");
            context.setCurrentProvider(provider);

            if (context.getSession() != null) {
                context.getSession().setProvider(provider);
                if (providerChanged) {
                    clearSessionUsage();
                }
            }

            if (providerChanged) {
                usagePushService.clearUsageDisplay();
            }

            // Bug fix (Node process leak L2): when the tab moves AWAY from Claude
            // to another SDK family (currently only Codex), the lingering Claude
            // daemon would otherwise stay alive for the rest of the tab's lifetime.
            // The daemon caches process.env, so even if the user comes back to
            // Claude with refreshed credentials, the cached env would persist —
            // shutting it down here forces the next Claude message to spawn a
            // fresh daemon. The daemon restart on return is lazy (deferred to
            // the next claude.send call), so users pay ~5–10s only when they
            // actually send the next Claude message.
            shutdownStaleClaudeDaemonIfLeavingClaude(previousProvider, provider);

            refreshSlashCommandsForProvider(provider);
            usagePushService.refreshContextBar();
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set provider: " + e.getMessage(), e);
        }
    }

    /**
     * Pure decision predicate: should we shut down the Claude daemon when the
     * tab provider transitions from {@code previousProvider} to {@code newProvider}?
     *
     * <p>Returns true only on Claude → non-Claude transitions. Same-direction
     * reaffirmations (e.g. {@code set_provider("codex")} fired again on every
     * message send) must not restart the daemon, and Claude → Claude
     * reaffirmations must keep the warm daemon alive.
     *
     * <p>Package-private so unit tests can verify the full transition matrix
     * without spinning up a HandlerContext or ClaudeSDKBridge.
     */
    static boolean shouldShutdownClaudeDaemonOnProviderSwitch(String previousProvider, String newProvider) {
        if (!"claude".equals(previousProvider)) {
            return false;
        }
        // Empty/null newProvider means "not set yet" (initialization, race), NOT
        // "user moved away from Claude". Treating it as a leave-claude transition
        // would cause spurious daemon restarts (~5–10s) when set_provider arrives
        // before the tab has fully booted.
        if (newProvider == null || newProvider.isEmpty() || "claude".equals(newProvider)) {
            return false;
        }
        return true;
    }

    /**
     * Return whether a provider command represents a real cross-provider switch.
     * Null/empty initialization values and same-provider reaffirmations are no-ops.
     */
    static boolean isActualProviderSwitch(String previousProvider, String newProvider) {
        return previousProvider != null
                && newProvider != null
                && !previousProvider.isEmpty()
                && !newProvider.isEmpty()
                && !previousProvider.equals(newProvider);
    }

    /**
     * Return whether a model command represents a real model transition.
     * Null/empty initialization values and same-model reaffirmations are no-ops.
     */
    static boolean isActualModelSwitch(String previousModel, String newModel) {
        return previousModel != null
                && newModel != null
                && !previousModel.isEmpty()
                && !newModel.isEmpty()
                && !previousModel.equals(newModel);
    }

    /**
     * Resolve the authoritative model before processing a frontend model command.
     * A restored session may already own the saved model while the handler context
     * still contains its startup default, so session state takes precedence.
     */
    static String resolveCurrentSessionModel(HandlerContext context) {
        if (context != null && context.getSession() != null) {
            String sessionModel = context.getSession().getModel();
            if (sessionModel != null && !sessionModel.isEmpty()) {
                return sessionModel;
            }
        }
        return context == null ? null : context.getCurrentModel();
    }

    /**
     * Shut down the Claude daemon when leaving the Claude family.
     * Delegates the decision to {@link #shouldShutdownClaudeDaemonOnProviderSwitch}
     * and only performs the side effect (calling
     * {@link com.github.claudecodegui.provider.claude.ClaudeSDKBridge#shutdownDaemon()})
     * when the decision says yes and the bridge is present.
     *
     * @return true when shutdown was actually invoked
     */
    boolean shutdownStaleClaudeDaemonIfLeavingClaude(String previousProvider, String newProvider) {
        if (!shouldShutdownClaudeDaemonOnProviderSwitch(previousProvider, newProvider)) {
            return false;
        }
        if (context.getClaudeSDKBridge() == null) {
            return false;
        }
        try {
            context.getClaudeSDKBridge().shutdownDaemon();
            LOG.info("[ModelProviderHandler] Shut down Claude daemon after switching to: " + newProvider);
            return true;
        } catch (Exception e) {
            LOG.warn("[ModelProviderHandler] Failed to shut down Claude daemon on provider switch: "
                    + e.getMessage(), e);
            return false;
        }
    }

    public void handleSetReasoningEffort(String content) {
        try {
            String effort = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("reasoningEffort")) {
                        effort = json.get("reasoningEffort").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the effort
                }
            }

            LOG.info("[ModelProviderHandler] Setting reasoning effort to: " + effort);

            if (context.getSession() != null) {
                context.getSession().setReasoningEffort(effort);
            }
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set reasoning effort: " + e.getMessage(), e);
        }
    }

    public void handleSetCodexFastMode(String content) {
        try {
            String mode = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("codexFastMode")) {
                        mode = json.get("codexFastMode").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the mode
                }
            }

            String serviceTier = SessionSendService.resolveEffectiveCodexServiceTier(mode, null);
            LOG.info("[ModelProviderHandler] Setting Codex fast mode to: " + mode
                    + ", serviceTier=" + (serviceTier != null ? serviceTier : "standard"));

            if (context.getSession() != null) {
                context.getSession().setCodexServiceTier(serviceTier);
            }
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set Codex fast mode: " + e.getMessage(), e);
        }
    }

    private void refreshSlashCommandsForProvider(String provider) {
        String cwd = null;
        if (context.getSession() != null) {
            cwd = context.getSession().getCwd();
        }
        if (cwd == null) {
            cwd = context.getProject().getBasePath();
        }

        final String finalCwd = cwd;
        CompletableFuture.runAsync(() -> {
            String currentFilePath = EditorFileUtils.getCurrentEditorFilePath(context.getProject());
            var commands = SlashCommandRegistry.getCommands(provider, finalCwd, currentFilePath);
            String json = SlashCommandRegistry.toJson(commands);

            final String codexJson;
            if ("codex".equalsIgnoreCase(provider)) {
                var codexSkills = SlashCommandRegistry.getCodexSkills(finalCwd);
                codexJson = SlashCommandRegistry.toJson(codexSkills);
                LOG.info("[ModelProviderHandler] Codex skills refreshed: " + codexSkills.size() + " skills");
            } else {
                codexJson = null;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    context.callJavaScript("updateSlashCommands", context.escapeJs(json));
                    if (codexJson != null) {
                        context.callJavaScript("window.updateDollarCommands", context.escapeJs(codexJson));
                    }
                } catch (Exception e) {
                    LOG.warn("[ModelProviderHandler] Failed to refresh slash commands: " + e.getMessage());
                }
            });
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[ModelProviderHandler] Failed to refresh slash commands asynchronously: " + ex.getMessage(), ex);
            return null;
        });
    }

    private String resolveConfiguredClaudeModelFromSettings(String baseModel) {
        if (context.getSettingsService() == null) {
            return baseModel;
        }
        try {
            JsonObject claudeSettings = context.getSettingsService().readClaudeSettings();
            if (claudeSettings == null || !claudeSettings.has("env") || !claudeSettings.get("env").isJsonObject()) {
                return baseModel;
            }
            return resolveConfiguredClaudeModel(baseModel, claudeSettings.getAsJsonObject("env"));
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to resolve actual model name: " + e.getMessage());
        }

        return baseModel;
    }

    public static String resolveConfiguredClaudeModel(String baseModel, JsonObject env) {
        if (baseModel == null || baseModel.isEmpty() || env == null) {
            return baseModel;
        }

        String lowerBaseModel = baseModel.toLowerCase();
        boolean isClaudeModel = lowerBaseModel.startsWith("claude-") || lowerBaseModel.startsWith("claude_");
        if (!isClaudeModel) {
            return baseModel;
        }

        String familyKey = familyModelEnvKey(lowerBaseModel);
        if (familyKey == null) {
            // Like the bridge, an id without a family name is sent as-is; the
            // ANTHROPIC_MODEL fallback only applies inside a family.
            return baseModel;
        }

        String mappedModel = readConfiguredEnvValue(env, familyKey);
        if (mappedModel == null) {
            mappedModel = readConfiguredEnvValue(env, "ANTHROPIC_MODEL");
        }
        return mappedModel == null ? baseModel : preserveRequested1MContext(baseModel, mappedModel);
    }

    private static String familyModelEnvKey(String lowerModel) {
        if (lowerModel.contains("fable")) {
            return "ANTHROPIC_DEFAULT_FABLE_MODEL";
        }
        if (lowerModel.contains("opus")) {
            return "ANTHROPIC_DEFAULT_OPUS_MODEL";
        }
        if (lowerModel.contains("haiku")) {
            return "ANTHROPIC_DEFAULT_HAIKU_MODEL";
        }
        if (lowerModel.contains("sonnet")) {
            return "ANTHROPIC_DEFAULT_SONNET_MODEL";
        }
        return null;
    }

    /**
     * A settings mapping replaces the model name but not the user's 1M choice.
     * This mirrors {@code resolveModelFromSettings} in ai-bridge: the request owns
     * the suffix, so any suffix carried by the mapped value is stripped first and
     * re-appended only when the request asks for 1M.
     */
    static String preserveRequested1MContext(String requestedModel, String mappedModel) {
        if (mappedModel == null || requestedModel == null) {
            return mappedModel;
        }
        String base = mappedModel.replaceFirst("(?i)\\[1m\\]$", "");
        return requestedModel.toLowerCase().endsWith("[1m]") ? base + "[1m]" : base;
    }

    private static String readConfiguredEnvValue(JsonObject env, String key) {
        if (env == null || key == null || !env.has(key) || env.get(key).isJsonNull()) {
            return null;
        }

        String value = env.get(key).getAsString();
        if (value == null) {
            return null;
        }

        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return 200_000;
        }

        Integer suffixLimit = parseCapacitySuffix(model);
        if (suffixLimit != null) {
            return suffixLimit;
        }

        return MODEL_CONTEXT_LIMITS.getOrDefault(model, 200_000);
    }

    /**
     * Parses an explicit capacity suffix such as {@code [1m]} or {@code [500k]}.
     *
     * @return the capacity in tokens, or null when the model id carries no suffix
     */
    static Integer parseCapacitySuffix(String model) {
        if (model == null) {
            return null;
        }
        Matcher matcher = CAPACITY_SUFFIX_PATTERN.matcher(model);

        if (matcher.find()) {
            try {
                double value = Double.parseDouble(matcher.group(1));
                String unit = matcher.group(2).toLowerCase();

                if ("m".equals(unit)) {
                    return (int)(value * 1_000_000);
                } else if ("k".equals(unit)) {
                    return (int)(value * 1_000);
                }
            } catch (NumberFormatException e) {
                LOG.error("Failed to parse capacity from model name: " + model);
            }
        }
        return null;
    }

    public static int getModelContextLimit(String provider, String model) {
        return CustomModelContextWindowProvider.getInstance()
                .getContextWindow(provider, model)
                .orElseGet(() -> getModelContextLimit(model));
    }

    /**
     * Context window the Claude CLI uses for the model id it receives.
     *
     * <p>Mirrors the CLI's own resolution:</p>
     * <ul>
     *   <li>With {@code DISABLE_COMPACT} set, {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} applies
     *       to every model and wins even over {@code [1m]}.</li>
     *   <li>Otherwise {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} only applies to ids the CLI does not
     *       treat as Claude models; a {@code claude-*} id keeps its built-in window.</li>
     *   <li>A {@code [1m]} opt-in yields at least 1M and never shrinks a larger override.</li>
     *   <li>Other capacity suffixes such as {@code [500k]} are a plugin convention and win
     *       over the override.</li>
     *   <li>The static model table is the last fallback.</li>
     * </ul>
     *
     * @param cliModel model id after the settings mapping, as sent to the CLI
     * @param cwd      session working directory for project-level settings, or null
     */
    public static int getClaudeContextLimit(String cliModel, String cwd) {
        ClaudeContextWindowOverrideProvider overrides = ClaudeContextWindowOverrideProvider.getInstance();
        OptionalInt configured = overrides.getOverride(cwd);
        if (configured.isPresent() && overrides.isCompactDisabled(cwd)) {
            return configured.getAsInt();
        }
        OptionalInt override = isCliRecognizedClaudeModel(cliModel) ? OptionalInt.empty() : configured;
        Integer suffixLimit = parseCapacitySuffix(cliModel);
        if (suffixLimit == null) {
            return override.orElseGet(() -> getModelContextLimit(cliModel));
        }
        return ONE_MILLION_SUFFIX_PATTERN.matcher(cliModel).find()
                ? Math.max(suffixLimit, override.orElse(0))
                : suffixLimit;
    }

    /**
     * The CLI ignores {@code CLAUDE_CODE_MAX_CONTEXT_TOKENS} for ids it recognizes as
     * Claude models, which in practice means any {@code claude-*} id.
     */
    static boolean isCliRecognizedClaudeModel(String model) {
        return model != null && model.trim().toLowerCase(Locale.ROOT).startsWith("claude-");
    }

    /**
     * Provider-aware context window used by usage display fallbacks.
     *
     * <p>For Claude, {@code selectedModel} is the UI id; the settings family mapping is
     * applied first so the window belongs to the model the bridge actually sends.</p>
     *
     * @param cwd session working directory for project-level settings, or null
     */
    public static int resolveContextLimit(String provider, String selectedModel, String cwd) {
        if (!"claude".equalsIgnoreCase(provider)) {
            return getModelContextLimit(provider, selectedModel);
        }
        JsonObject env = ClaudeContextWindowOverrideProvider.getInstance().getUserSettingsEnv();
        String cliModel = env == null ? selectedModel : resolveConfiguredClaudeModel(selectedModel, env);
        return getClaudeContextLimit(cliModel, cwd);
    }

    /**
     * @return the active session's working directory, or null when there is no session yet
     */
    public static String sessionCwd(HandlerContext context) {
        if (context == null || context.getSession() == null) {
            return null;
        }
        return context.getSession().getCwd();
    }

    private void clearSessionUsage() {
        // Both call sites already verified the session is non-null.
        SessionState state = context.getSession().getState();
        synchronized (state.getMessageStateLock()) {
            TokenUsageUtils.clearContextUsageFromSessionMessages(state.getMessagesReference());
        }
    }

}
