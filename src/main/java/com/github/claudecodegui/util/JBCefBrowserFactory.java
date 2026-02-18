package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;

/**
 * JBCefBrowser factory.
 * Centrally manages JBCefBrowser creation, configuring the appropriate
 * OSR (Off-Screen Rendering) mode based on the platform and IDEA version.
 *
 * OSR mode behavior:
 * - macOS: OSR disabled (uses native rendering)
 * - Windows: OSR disabled
 * - Linux/Unix: OSR enabled for IDEA 2023+, disabled for earlier versions
 */
public final class JBCefBrowserFactory {

    private static final Logger LOG = Logger.getInstance(JBCefBrowserFactory.class);

    private JBCefBrowserFactory() {
        // Utility class, do not instantiate
    }

    /**
     * Create a JBCefBrowser instance.
     * Automatically selects the appropriate OSR setting based on the current platform and IDEA version.
     *
     * @return a JBCefBrowser instance
     */
    public static JBCefBrowser create() {
        boolean isOffScreenRendering = determineOsrMode();
        boolean isDevMode = PlatformUtils.isPluginDevMode();
        LOG.info("Creating JBCefBrowser with OSR=" + isOffScreenRendering
                + " (platform=" + getPlatformName() + ", ideaVersion=" + getIdeaMajorVersion()
                + ", devMode=" + isDevMode + ")");

        try {
            JBCefBrowser browser = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .setEnableOpenDevToolsMenuItem(isDevMode)
                    // .setCreateImmediately(true) // Causes new tabs to permanently stall on "Checking SDK status..." - commented out; using default lazy-load mode instead
                    .build();
            configureContextMenu(browser, isDevMode);
            LOG.info("JBCefBrowser created successfully using builder");
            return browser;
        } catch (Exception e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor: " + e.getMessage());
            JBCefBrowser browser = new JBCefBrowser();
            configureContextMenu(browser, isDevMode);
            return browser;
        }
    }

    /**
     * Create a JBCefBrowser instance and load the specified URL.
     *
     * @param url the URL to load
     * @return a JBCefBrowser instance
     */
    public static JBCefBrowser create(String url) {
        boolean isOffScreenRendering = determineOsrMode();
        boolean isDevMode = PlatformUtils.isPluginDevMode();
        LOG.info("Creating JBCefBrowser with URL and OSR=" + isOffScreenRendering + ", devMode=" + isDevMode);

        try {
            JBCefBrowser browser = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .setEnableOpenDevToolsMenuItem(isDevMode)
                    .setCreateImmediately(true)
                    .setUrl(url)
                    .build();
            configureContextMenu(browser, isDevMode);
            LOG.info("JBCefBrowser created successfully with URL");
            return browser;
        } catch (Exception e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor: " + e.getMessage());
            JBCefBrowser browser = new JBCefBrowser();
            if (url != null && !url.isEmpty()) {
                browser.loadURL(url);
            }
            configureContextMenu(browser, isDevMode);
            return browser;
        }
    }

    /**
     * Determine whether to enable OSR mode based on platform and IDEA version.
     *
     * @return true to enable OSR, false to disable
     */
    private static boolean determineOsrMode() {
        if (SystemInfo.isMac) {
            // macOS: disable OSR
            return false;
        } else if (SystemInfo.isLinux || SystemInfo.isUnix) {
            // Linux/Unix: depends on IDEA version
            int version = getIdeaMajorVersion();
            // Enable OSR for IDEA 2023+
            return version >= 2023;
        } else if (SystemInfo.isWindows) {
            // Windows: disable OSR
            return false;
        }
        // Unknown platform, disable OSR by default
        return false;
    }

    /**
     * Get the IDEA major version number.
     *
     * @return the IDEA major version (e.g., 2023, 2024), or 0 if parsing fails
     */
    private static int getIdeaMajorVersion() {
        try {
            ApplicationInfo appInfo = ApplicationInfo.getInstance();
            var majorVersion = appInfo.getMajorVersion();
            return Integer.parseInt(majorVersion);
        } catch (Exception e) {
            LOG.warn("Failed to get IDEA version: " + e.getMessage());
        }
        return 0;
    }

    /**
     * Get the current platform name (for logging purposes).
     *
     * @return the platform name
     */
    private static String getPlatformName() {
        if (SystemInfo.isMac) {
            return "macOS";
        } else if (SystemInfo.isLinux) {
            return "Linux";
        } else if (SystemInfo.isUnix) {
            return "Unix";
        } else if (SystemInfo.isWindows) {
            return "Windows";
        }
        return "Unknown";
    }

    /**
     * Check whether JCEF is available.
     *
     * @return true if JCEF is supported
     */
    public static boolean isJcefSupported() {
        try {
            return com.intellij.ui.jcef.JBCefApp.isSupported();
        } catch (Exception e) {
            LOG.warn("Failed to check JCEF support: " + e.getMessage());
            return false;
        }
    }

    /**
     * Configure the browser context menu.
     * Enables the context menu in development mode and disables it in production.
     *
     * @param browser the JBCefBrowser instance
     */
    private static void configureContextMenu(JBCefBrowser browser, boolean isDevMode) {
        browser.setProperty(JBCefBrowserBase.Properties.NO_CONTEXT_MENU, !isDevMode);
        LOG.info("Context menu " + (isDevMode ? "enabled" : "disabled") + " (devMode=" + isDevMode + ")");
    }
}
