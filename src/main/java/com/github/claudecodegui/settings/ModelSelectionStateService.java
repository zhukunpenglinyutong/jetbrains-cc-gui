package com.github.claudecodegui.settings;

import com.github.claudecodegui.session.ClaudeSession;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Persists the last selected provider/model outside the webview lifecycle.
 */
public final class ModelSelectionStateService {

    private static final Logger LOG = Logger.getInstance(ModelSelectionStateService.class);

    public static final String PROVIDER_CLAUDE = "claude";
    public static final String PROVIDER_CODEX = "codex";
    public static final String DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
    public static final String DEFAULT_CODEX_MODEL = "gpt-5.5";

    private static final String PROVIDER_KEY = "claude.code.model.provider";
    private static final String CLAUDE_MODEL_KEY = "claude.code.model.claude";
    private static final String CODEX_MODEL_KEY = "claude.code.model.codex";

    private ModelSelectionStateService() {
    }

    public static Selection loadSelection() {
        String provider = normalizeProvider(PropertiesComponent.getInstance().getValue(PROVIDER_KEY));
        return new Selection(provider, loadModelForProvider(provider));
    }

    public static boolean hasSavedSelection() {
        PropertiesComponent props = PropertiesComponent.getInstance();
        return isNonEmpty(props.getValue(PROVIDER_KEY))
                || isNonEmpty(props.getValue(CLAUDE_MODEL_KEY))
                || isNonEmpty(props.getValue(CODEX_MODEL_KEY));
    }

    public static String loadModelForProvider(String provider) {
        String normalizedProvider = normalizeProvider(provider);
        String key = PROVIDER_CODEX.equals(normalizedProvider) ? CODEX_MODEL_KEY : CLAUDE_MODEL_KEY;
        String savedModel = PropertiesComponent.getInstance().getValue(key);
        if (isNonEmpty(savedModel)) {
            return savedModel.trim();
        }
        return PROVIDER_CODEX.equals(normalizedProvider) ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
    }

    public static void saveProvider(String provider) {
        String normalizedProvider = normalizeProvider(provider);
        try {
            PropertiesComponent.getInstance().setValue(PROVIDER_KEY, normalizedProvider);
            LOG.info("[ModelSelection] Saved provider: " + normalizedProvider);
        } catch (Exception e) {
            LOG.warn("[ModelSelection] Failed to save provider: " + e.getMessage());
        }
    }

    public static void saveModel(String provider, String model) {
        if (!isNonEmpty(model)) {
            return;
        }
        String normalizedProvider = normalizeProvider(provider);
        String key = PROVIDER_CODEX.equals(normalizedProvider) ? CODEX_MODEL_KEY : CLAUDE_MODEL_KEY;
        try {
            PropertiesComponent.getInstance().setValue(key, model.trim());
            LOG.info("[ModelSelection] Saved model for provider=" + normalizedProvider + ": " + model.trim());
        } catch (Exception e) {
            LOG.warn("[ModelSelection] Failed to save model: " + e.getMessage());
        }
    }

    public static void applyToSession(ClaudeSession session) {
        if (session == null) {
            return;
        }

        Selection selection = loadSelection();
        session.setProvider(selection.provider);
        session.setModel(selection.model);
        LOG.info("[ModelSelection] Applied persisted selection to session: provider="
                + selection.provider + ", model=" + selection.model);
    }

    public static String normalizeProvider(String provider) {
        if (provider != null && PROVIDER_CODEX.equalsIgnoreCase(provider.trim())) {
            return PROVIDER_CODEX;
        }
        return PROVIDER_CLAUDE;
    }

    private static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }

    public static final class Selection {
        public final String provider;
        public final String model;

        private Selection(String provider, String model) {
            this.provider = provider;
            this.model = model;
        }
    }
}
