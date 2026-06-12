package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Test;

import static org.junit.Assert.assertFalse;

/**
 * Guards the security wiring of the code-font handler: an invalid custom font request must be
 * rejected by {@code validateCustomUiFontFile} BEFORE anything is persisted. The underlying
 * validator itself is covered by {@code FontConfigServiceUiFontResolutionTest}; here we verify
 * the handler actually honours the validation result instead of persisting blindly.
 */
public class ProjectConfigHandlerCodeFontConfigTest {

    @Test
    public void handleSetCodeFontConfigRejectsNonExistentCustomFontWithoutPersisting() {
        RecordingSettingsService settingsService = new RecordingSettingsService();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(settingsService));

        invokeToleratingMissingPlatform(() -> handler.handleSetCodeFontConfig(
                "{\"mode\":\"customFile\",\"customFontPath\":\"/tmp/cc-gui-missing-font.ttf\"}"));

        assertFalse(
                "A custom-file request pointing at a non-existent font must not be persisted",
                settingsService.setCodeFontConfigCalled);
    }

    @Test
    public void handleSetCodeFontConfigRejectsUnsupportedExtensionWithoutPersisting() {
        RecordingSettingsService settingsService = new RecordingSettingsService();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(settingsService));

        invokeToleratingMissingPlatform(() -> handler.handleSetCodeFontConfig(
                "{\"mode\":\"customFile\",\"customFontPath\":\"/tmp/not-a-font.txt\"}"));

        assertFalse(
                "An unsupported font extension must not be persisted",
                settingsService.setCodeFontConfigCalled);
    }

    /**
     * The rejection branch calls {@code showError()}, which routes through
     * {@code ApplicationManager.getApplication().invokeLater()} — null in this lightweight unit
     * test (no IntelliJ Application booted) — and the resulting failure is then re-raised by
     * IntelliJ's {@code DefaultLogger.error()} as an {@link AssertionError} (its documented
     * test-mode behaviour). Neither is a {@link RuntimeException}, so we tolerate any
     * {@link Throwable}; the security invariant we actually assert is that the invalid request
     * never reached {@code setCodeFontConfig}.
     */
    private void invokeToleratingMissingPlatform(Runnable action) {
        try {
            action.run();
        } catch (Throwable ignored) {
            // Expected without a booted IntelliJ platform — see method javadoc.
        }
    }

    private HandlerContext contextWith(CodemossSettingsService settingsService) {
        return new HandlerContext(
                null,
                null,
                null,
                settingsService,
                new HandlerContext.JsCallback() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                    }

                    @Override
                    public String escapeJs(String str) {
                        return str;
                    }
                }
        );
    }

    private static class RecordingSettingsService extends CodemossSettingsService {
        private boolean setCodeFontConfigCalled = false;

        @Override
        public void setCodeFontConfig(String mode, String customFontPath) {
            setCodeFontConfigCalled = true;
        }
    }
}
