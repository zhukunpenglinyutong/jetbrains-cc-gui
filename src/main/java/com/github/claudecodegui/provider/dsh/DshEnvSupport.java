package com.github.claudecodegui.provider.dsh;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Map;

/**
 * Injects the DSH connection settings ({@code DSH_BIN} / {@code DSH_HOST} /
 * {@code DSH_PORT} / {@code DSH_AUTO_START}) into a Node bridge process
 * environment. Shared by the send bridge, history reader, models handler, and
 * settings-card host commands so every path honors the same configured origin.
 */
public final class DshEnvSupport {

    private static final Logger LOG = Logger.getInstance(DshEnvSupport.class);

    private DshEnvSupport() {
    }

    public static void inject(Map<String, String> env, CodemossSettingsService settings) {
        if (env == null || settings == null) {
            return;
        }
        try {
            String bin = settings.getDshBin();
            if (bin != null && !bin.isBlank()) {
                env.put("DSH_BIN", bin.trim());
            }
            String host = settings.getDshHost();
            if (host != null && !host.isBlank()) {
                env.put("DSH_HOST", host.trim());
            }
            int port = settings.getDshPort();
            if (port > 0) {
                env.put("DSH_PORT", String.valueOf(port));
            }
            env.put("DSH_AUTO_START", String.valueOf(settings.getDshAutoStart()));
        } catch (Exception e) {
            LOG.warn("[DSH] Failed to load connection settings, using defaults: " + e.getMessage());
        }
    }
}
