package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pins the CLI-provider set of {@link CliModelsHandler} (review patch R-17).
 * A provider dropped from {@code SUPPORTED_PROVIDERS} silently breaks that
 * provider's model list in the webview while every other provider keeps
 * working, so the set is asserted explicitly instead of only observed live.
 */
public class CliModelsHandlerProvidersTest {

    @Test
    public void supportedProvidersIncludeGemini() {
        assertTrue("gemini must be a supported CLI model provider",
                CliModelsHandler.SUPPORTED_PROVIDERS.contains("gemini"));
    }

    @Test
    public void supportedProvidersCoverEveryBundledCliProvider() {
        for (String provider : new String[]{"opencode", "kimi", "pi", "omp", "codex", "grok", "dsh"}) {
            assertTrue("missing CLI model provider: " + provider,
                    CliModelsHandler.SUPPORTED_PROVIDERS.contains(provider));
        }
    }

    @Test
    public void sdkAndUnknownProvidersStayOut() {
        assertFalse(CliModelsHandler.SUPPORTED_PROVIDERS.contains("claude"));
        assertFalse(CliModelsHandler.SUPPORTED_PROVIDERS.contains(""));
        assertFalse(CliModelsHandler.SUPPORTED_PROVIDERS.contains("no-such-provider"));
    }
}
