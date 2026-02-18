package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.ide.ui.LafManager;
import com.intellij.ide.ui.LafManagerListener;
import com.intellij.ui.JBColor;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.awt.Color;

/**
 * IDE theme configuration service.
 * Retrieves the current UI theme (light/dark) from IDEA and provides it to the Webview.
 *
 * Uses IntelliJ Platform public APIs:
 * - JBColor.isBright() - detects whether the current theme is light
 * - LafManagerListener - listens for all theme change events (including Sync with OS)
 *
 * References:
 * - https://github.com/JetBrains/intellij-community/blob/master/platform/util/ui/src/com/intellij/ui/JBColor.java
 * - https://plugins.jetbrains.com/docs/intellij/themes-getting-started.html
 */
public class ThemeConfigService {

    private static final Logger LOG = Logger.getInstance(ThemeConfigService.class);

    // Theme background color constants - centrally managed for frontend/backend consistency
    public static final Color DARK_BG_COLOR = new Color(30, 30, 30);   // #1e1e1e
    public static final Color LIGHT_BG_COLOR = Color.WHITE;             // #ffffff
    public static final String DARK_BG_HEX = "#1e1e1e";
    public static final String LIGHT_BG_HEX = "#ffffff";
    private static ThemeChangeCallback themeChangeCallback = null;
    private static Boolean lastKnownIsDark = null; // Cache the last known theme state for deduplication
    private static boolean listenerRegistered = false;

    /**
     * Callback interface for theme changes.
     */
    public interface ThemeChangeCallback {
        void onThemeChanged(JsonObject themeConfig);
    }

    /**
     * Register a theme change listener.
     * Uses LafManagerListener to listen for all Look and Feel changes.
     *
     * The listener fires in these situations:
     * - User manually switches theme (View - Appearance - Theme)
     * - IDE follows OS theme changes (Settings - Sync with OS enabled)
     * - Toggling Sync with OS causes an actual theme change
     * - Installing or switching to a custom theme
     *
     * Notes:
     * - The listener is registered once (Application level) and remains active for the IDE's lifetime
     * - Each call updates the callback, supporting project close/reopen scenarios
     */
    public static void registerThemeChangeListener(ThemeChangeCallback callback) {
        // Always update the callback to support project reopen scenarios
        // Even if listenerRegistered is true, the callback needs updating after project reopen
        themeChangeCallback = callback;
        LOG.info("[ThemeConfig] Theme change callback updated");

        // Register the listener only once (Application level)
        if (listenerRegistered) {
            LOG.debug("[ThemeConfig] Listener already registered, callback updated");
            return;
        }

        listenerRegistered = true;

        try {
            // Register on the Application-level MessageBus
            // The listener remains active for the IDE's entire lifecycle, even across project close/reopen
            ApplicationManager.getApplication().getMessageBus()
                .connect()
                .subscribe(LafManagerListener.TOPIC, new LafManagerListener() {
                    @Override
                    public void lookAndFeelChanged(LafManager source) {
                        LOG.info("[ThemeConfig] Look and Feel changed event received");

                        // Defer execution to ensure the UI theme is fully updated
                        // Using invokeLater ensures this runs on the next EDT cycle, when the new theme is in effect
                        ApplicationManager.getApplication().invokeLater(() -> {
                            notifyThemeChange();
                        });
                    }
                });

            LOG.info("[ThemeConfig] Theme change listener registered successfully (Application level)");
        } catch (Exception e) {
            LOG.error("[ThemeConfig] Failed to register theme change listener: " + e.getMessage(), e);
        }
    }

    /**
     * Notify the frontend of a theme change.
     * Only sends a notification when the theme actually changes, avoiding duplicate notifications and unnecessary UI updates.
     */
    private static void notifyThemeChange() {
        if (themeChangeCallback == null) {
            LOG.warn("[ThemeConfig] Theme callback is null, cannot notify");
            return;
        }

        try {
            JsonObject config = getIdeThemeConfig();
            boolean currentIsDark = config.get("isDark").getAsBoolean();

            // Deduplicate: skip notification if the theme state hasn't changed
            if (lastKnownIsDark != null && lastKnownIsDark == currentIsDark) {
                LOG.debug("[ThemeConfig] Theme state unchanged (isDark=" + currentIsDark + "), skipping notification");
                return;
            }

            // Update cache and notify
            lastKnownIsDark = currentIsDark;
            LOG.info("[ThemeConfig] Theme changed to: " + (currentIsDark ? "DARK" : "LIGHT") + ", notifying webview");
            themeChangeCallback.onThemeChanged(config);
        } catch (Exception e) {
            LOG.error("[ThemeConfig] Failed to notify theme change: " + e.getMessage(), e);
        }
    }

    /**
     * Get the IDE theme configuration.
     *
     * Uses the IntelliJ Platform public API JBColor.isBright().
     * JBColor.isBright() returns true for a light theme; negating it gives the dark theme state.
     *
     * @return a JsonObject containing the theme config, format: {"isDark": true/false}
     */
    public static JsonObject getIdeThemeConfig() {
        JsonObject config = new JsonObject();

        try {
            // Use IntelliJ's public API to detect whether the theme is dark
            // JBColor.isBright() returns true for light theme; negate to get dark theme
            boolean isDark = !JBColor.isBright();

            config.addProperty("isDark", isDark);

            LOG.debug("[ThemeConfig] Retrieved IDE theme config: isDark=" + isDark);
        } catch (Exception e) {
            // Fall back to default (dark) on exception
            config.addProperty("isDark", true);
            LOG.error("[ThemeConfig] Failed to get theme config, using default (dark): " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * Get the theme configuration as a JSON string.
     * Also updates the cached theme state to ensure accurate subsequent change detection.
     *
     * @return the theme configuration as a JSON string
     */
    public static String getIdeThemeConfigJson() {
        JsonObject config = getIdeThemeConfig();

        // Update cache to ensure accurate subsequent change detection
        // After initial load, only actual changes will trigger notifications
        lastKnownIsDark = config.get("isDark").getAsBoolean();

        return new Gson().toJson(config);
    }

    /**
     * Get the Swing background color corresponding to the current IDE theme.
     * A unified method for obtaining background color, ensuring frontend/backend color consistency.
     *
     * @return the background color for the current theme (Dark: #1e1e1e, Light: #ffffff)
     */
    public static Color getBackgroundColor() {
        try {
            boolean isDark = getIdeThemeConfig().get("isDark").getAsBoolean();
            return isDark ? DARK_BG_COLOR : LIGHT_BG_COLOR;
        } catch (Exception e) {
            LOG.warn("Failed to get theme background color, using dark as fallback: " + e.getMessage());
            return DARK_BG_COLOR;
        }
    }

    /**
     * Get the hex color value corresponding to the current IDE theme.
     * Used for injection into HTML.
     *
     * @return the background color hex value for the current theme
     */
    public static String getBackgroundColorHex() {
        try {
            boolean isDark = getIdeThemeConfig().get("isDark").getAsBoolean();
            return isDark ? DARK_BG_HEX : LIGHT_BG_HEX;
        } catch (Exception e) {
            LOG.warn("Failed to get theme background color hex, using dark as fallback: " + e.getMessage());
            return DARK_BG_HEX;
        }
    }
}
