package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;

public final class PermissionDialogTimeoutSettings {

    private static final Logger LOG = Logger.getInstance(PermissionDialogTimeoutSettings.class);

    public static final int DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 300;
    public static final int MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;
    public static final int MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS = 3600;
    /**
     * Buffer added on top of the user-facing dialog timeout when scheduling the Java safety net
     * and the Node IPC safety net. Kept centrally so the JVM-side safety net and the Node bridge
     * cannot drift apart.
     */
    public static final long PERMISSION_SAFETY_NET_BUFFER_SECONDS = 60L;

    private PermissionDialogTimeoutSettings() {
    }

    public static int clampPermissionDialogTimeoutSeconds(int seconds) {
        return Math.max(MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS,
                Math.min(MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS, seconds));
    }

    public static int getPermissionDialogTimeoutSeconds(CodemossSettingsService service) throws IOException {
        JsonObject config = service.readConfig();

        if (!config.has("permissionDialogTimeoutSeconds")) {
            return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }

        try {
            int timeout = config.get("permissionDialogTimeoutSeconds").getAsInt();
            return clampPermissionDialogTimeoutSeconds(timeout);
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Invalid permissionDialogTimeoutSeconds value, rewriting default to disk; errorClass="
                    + e.getClass().getSimpleName());
            try {
                config.addProperty("permissionDialogTimeoutSeconds", DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS);
                service.writeConfig(config);
            } catch (IOException rewriteError) {
                LOG.warn("[CodemossSettings] Failed to self-heal permissionDialogTimeoutSeconds; errorClass="
                        + rewriteError.getClass().getSimpleName());
            }
            return DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }
    }

    public static void setPermissionDialogTimeoutSeconds(CodemossSettingsService service, int seconds) throws IOException {
        int clamped = clampPermissionDialogTimeoutSeconds(seconds);
        JsonObject config = service.readConfig();
        config.addProperty("permissionDialogTimeoutSeconds", clamped);
        service.writeConfig(config);
    }
}
