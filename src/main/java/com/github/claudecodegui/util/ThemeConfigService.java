package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.ide.ui.LafManager;
import com.intellij.ide.ui.LafManagerListener;
import com.intellij.ui.JBColor;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.awt.Color;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicLong;

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
    private static Boolean lastKnownIsDark = null; // Cache the last known theme state for deduplication
    // Written from window-registration threads, read from the LafManager/EDT thread.
    private static volatile boolean listenerRegistered = false;

    // Multi-callback support: each ClaudeChatWindow registers its own callback so that
    // theme changes are delivered to every open session, not just the last one registered.
    // CopyOnWriteArraySet ensures safe iteration on the LafManager thread without explicit locking.
    private static final CopyOnWriteArraySet<RegisteredCallback> themeChangeCallbacks = new CopyOnWriteArraySet<>();
    private static final AtomicLong callbackIdSeq = new AtomicLong(0);

    // Slot for callbacks registered via the legacy no-handle overload. Each legacy call
    // replaces the previous slot (preserving the original "update on project reopen"
    // semantics) so repeated registrations never accumulate duplicates in the set.
    private static volatile RegisteredCallback legacySlot = null;

    /**
     * Opaque handle returned by {@link #registerThemeChangeListener(ThemeChangeCallback, boolean)}
     * for later unregistration via {@link #unregisterThemeChangeListener(RegisteredCallback)}.
     */
    public static final class RegisteredCallback {
        private final long id;
        private final ThemeChangeCallback callback;

        RegisteredCallback(long id, ThemeChangeCallback callback) {
            this.id = id;
            this.callback = callback;
        }

        long getId() { return id; }
        ThemeChangeCallback getCallback() { return callback; }
    }

    /**
     * Callback interface for theme changes.
     */
    public interface ThemeChangeCallback {
        void onThemeChanged(JsonObject themeConfig);
    }

    /**
     * Register a theme change listener (backward-compatible no-handle overload).
     *
     * <p>Each call <em>replaces</em> the previous no-handle registration, preserving the
     * original single-callback semantics (e.g. a project reopen re-registers without
     * accumulating duplicates). New callers should prefer
     * {@link #registerThemeChangeListener(ThemeChangeCallback, boolean)} which returns a
     * handle that can be used for clean unregistration on dispose.
     *
     * @param callback the callback to invoke on theme change
     */
    public static void registerThemeChangeListener(ThemeChangeCallback callback) {
        ensureListenerRegistered();

        RegisteredCallback slot = new RegisteredCallback(callbackIdSeq.incrementAndGet(), callback);
        RegisteredCallback prev = legacySlot;
        legacySlot = slot;
        if (prev != null) {
            themeChangeCallbacks.remove(prev);
        }
        if (callback != null) {
            themeChangeCallbacks.add(slot);
        }
        LOG.info("[ThemeConfig] Legacy (no-handle) theme change callback updated");
    }

    /**
     * Register a theme change listener and return a handle for later unregistration.
     *
     * <p>Each {@link com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow ClaudeChatWindow}
     * registers its own callback so that theme changes are delivered to <em>every</em> open
     * session, not just the last one registered. The returned handle should be passed to
     * {@link #unregisterThemeChangeListener(RegisteredCallback)} when the window is disposed
     * to prevent notifications to disposed webviews.
     *
     * <p>The listener is registered once at the Application level and remains active for the
     * IDE's lifetime. Multiple callbacks can coexist and are all notified on each theme change.
     *
     * @param callback the callback to invoke on theme change
     * @param returnHandle if {@code true}, returns a {@link RegisteredCallback} handle for
     *                     later unregistration; if {@code false}, behaves like the legacy
     *                     no-handle overload and returns {@code null}
     * @return a handle for unregistration, or {@code null} if {@code returnHandle} is false
     */
    public static RegisteredCallback registerThemeChangeListener(ThemeChangeCallback callback, boolean returnHandle) {
        if (!returnHandle) {
            registerThemeChangeListener(callback);
            return null;
        }

        // Register the listener only once (Application level)
        ensureListenerRegistered();

        RegisteredCallback handle = null;
        if (callback != null) {
            handle = new RegisteredCallback(callbackIdSeq.incrementAndGet(), callback);
            themeChangeCallbacks.add(handle);
            LOG.info("[ThemeConfig] Multi-callback registered (id=" + handle.getId()
                    + ", total=" + themeChangeCallbacks.size() + ")");
        }

        return handle;
    }

    /**
     * Unregister a previously registered theme change callback.
     *
     * <p>Should be called when a {@link com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow}
     * is disposed, so that theme changes no longer attempt to call JavaScript on a disposed
     * webview (which logs the warning "Cannot call JS function window.onIdeThemeChanged: disposed=true").
     *
     * @param handle the handle returned by {@link #registerThemeChangeListener(ThemeChangeCallback, boolean)}
     */
    public static void unregisterThemeChangeListener(RegisteredCallback handle) {
        if (handle == null) {
            return;
        }
        boolean removed = themeChangeCallbacks.remove(handle);
        if (removed) {
            LOG.info("[ThemeConfig] Multi-callback unregistered (id=" + handle.getId()
                    + ", remaining=" + themeChangeCallbacks.size() + ")");
            // Clear the legacy slot if the removed handle is the current legacy registration
            if (handle == legacySlot) {
                legacySlot = null;
            }
        }
    }

    /**
     * Ensure the LafManagerListener is registered exactly once at the Application level.
     */
    private static void ensureListenerRegistered() {
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
     * Notify all registered callbacks of a theme change.
     * Only sends a notification when the theme actually changes, avoiding duplicate notifications and unnecessary UI updates.
     */
    private static void notifyThemeChange() {
        if (themeChangeCallbacks.isEmpty()) {
            LOG.warn("[ThemeConfig] No theme callbacks registered, cannot notify");
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
            LOG.info("[ThemeConfig] Theme changed to: " + (currentIsDark ? "DARK" : "LIGHT")
                    + ", notifying " + themeChangeCallbacks.size() + " webview(s)");

            // Notify all registered callbacks (one per open ClaudeChatWindow)
            for (RegisteredCallback rc : themeChangeCallbacks) {
                try {
                    rc.getCallback().onThemeChanged(config);
                } catch (Exception e) {
                    LOG.warn("[ThemeConfig] Failed to notify callback id=" + rc.getId() + ": " + e.getMessage(), e);
                }
            }
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
