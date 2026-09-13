package com.github.claudecodegui.provider.dsh;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * DeepSeek Harness (DSH) bridge.
 *
 * <p>DSH is not a per-turn CLI: the Node channel talks Host RPC + WebSocket
 * mux to one persistent local {@code dsh web} (adopted or auto-spawned by the
 * Node supervisor). From the Java side it still speaks the shared marker
 * protocol, so streaming, tools, usage, and session id all ride the existing
 * Codex-style message handler.
 *
 * <p>Connection settings ({@code DSH_BIN} / {@code DSH_HOST} / {@code DSH_PORT}
 * / {@code DSH_AUTO_START}) come from the plugin config's {@code dsh} section;
 * provider keys and the model catalog stay in the DSH Web UI.
 */
public class DshCliBridge extends MarkerCliBridge {

    private final CodemossSettingsService settingsService = new CodemossSettingsService();

    public DshCliBridge() {
        super(DshCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "dsh";
    }

    @Override
    protected String getStdinEnvKey() {
        return "DSH_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        DshEnvSupport.inject(env, settingsService);
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new DshHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[DSH] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
