package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.gemini.GeminiCliBridge;
import com.github.claudecodegui.provider.kimi.KimiCliBridge;
import com.github.claudecodegui.provider.minimax.MiniMaxCliBridge;
import com.github.claudecodegui.provider.omp.OmpCliBridge;
import com.github.claudecodegui.provider.opencode.OpenCodeCliBridge;
import com.github.claudecodegui.provider.pi.PiCliBridge;
import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Pins the bundled CLI-bridge set of the chat window (review patch R-16).
 * The webview offers a provider only if the window registered a bridge for it,
 * so a provider dropped from {@link ClaudeChatWindow#registerBundledCliBridges}
 * (e.g. gemini) must fail here rather than surface as a silent "CLI provider
 * not registered" inside the IDE.
 */
public class ClaudeChatWindowCliBridgesTest {

    @Test
    public void bundledBridgeMapContainsAGeminiBridge() {
        Map<String, MarkerCliBridge> bridges = ClaudeChatWindow.registerBundledCliBridges(
                new KimiCliBridge(),
                new OpenCodeCliBridge(),
                new PiCliBridge(),
                new OmpCliBridge(),
                new GeminiCliBridge(),
                new MiniMaxCliBridge()
        );

        assertEquals(7, bridges.size());
        assertTrue("gemini must be registered as a CLI bridge",
                bridges.get("gemini") instanceof GeminiCliBridge);
        for (String provider : new String[]{"kimi", "opencode", "pi", "omp", "dsh", "minimax"}) {
            assertTrue("missing bundled bridge: " + provider, bridges.containsKey(provider));
        }
    }
}
