package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;

/**
 * JBCefBrowser 工厂类
 * 统一管理 JBCefBrowser 的创建，根据不同平台和 IDEA 版本设置合适的 OSR (Off-Screen Rendering) 模式
 *
 * OSR 模式说明：
 * - macOS: 关闭 OSR（使用原生渲染）
 * - Windows: 关闭 OSR
 * - Linux/Unix: IDEA 2023+ 开启 OSR，2023 以下关闭 OSR
 */
public final class JBCefBrowserFactory {

    private static final Logger LOG = Logger.getInstance(JBCefBrowserFactory.class);

    private JBCefBrowserFactory() {
        // 工具类，禁止实例化
    }

    /**
     * 创建 JBCefBrowser 实例
     * 根据当前平台和 IDEA 版本自动选择合适的 OSR 设置
     *
     * @return JBCefBrowser 实例
     */
    public static JBCefBrowser create() {
        boolean isOffScreenRendering = determineOsrMode();
        LOG.info("Creating JBCefBrowser with OSR=" + isOffScreenRendering
                + " (platform=" + getPlatformName() + ", ideaVersion=" + getIdeaMajorVersion() + ")");

        try {
            JBCefBrowser browser = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .build();
            configureContextMenu(browser);
            LOG.info("JBCefBrowser created successfully using builder");
            return browser;
        } catch (Exception e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor: " + e.getMessage());
            JBCefBrowser browser = new JBCefBrowser();
            configureContextMenu(browser);
            return browser;
        }
    }

    /**
     * 创建 JBCefBrowser 实例并加载指定 URL
     *
     * @param url 要加载的 URL
     * @return JBCefBrowser 实例
     */
    public static JBCefBrowser create(String url) {
        boolean isOffScreenRendering = determineOsrMode();
        LOG.info("Creating JBCefBrowser with URL and OSR=" + isOffScreenRendering);

        try {
            JBCefBrowser browser = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .setUrl(url)
                    .build();
            configureContextMenu(browser);
            LOG.info("JBCefBrowser created successfully with URL");
            return browser;
        } catch (Exception e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor: " + e.getMessage());
            JBCefBrowser browser = new JBCefBrowser();
            if (url != null && !url.isEmpty()) {
                browser.loadURL(url);
            }
            configureContextMenu(browser);
            return browser;
        }
    }

    /**
     * 根据平台和 IDEA 版本确定是否启用 OSR 模式
     *
     * @return true 表示启用 OSR，false 表示禁用
     */
    private static boolean determineOsrMode() {
        if (SystemInfo.isMac) {
            // macOS: 关闭 OSR
            return false;
        } else if (SystemInfo.isLinux || SystemInfo.isUnix) {
            // Linux/Unix: 根据 IDEA 版本决定
            int version = getIdeaMajorVersion();
            // IDEA 2023+ 开启 OSR
            return version >= 2023;
        } else if (SystemInfo.isWindows) {
            // Windows: 关闭 OSR
            return false;
        }
        // 未知平台，默认关闭 OSR
        return false;
    }

    /**
     * 获取 IDEA 主版本号
     *
     * @return IDEA 主版本号（如 2023, 2024 等），解析失败返回 0
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
     * 获取当前平台名称（用于日志）
     *
     * @return 平台名称
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
     * 检查 JCEF 是否可用
     *
     * @return true 表示 JCEF 可用
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
     * 配置浏览器右键菜单.
     * 在开发环境启用右键菜单，在生产环境禁用右键菜单。
     *
     * @param browser JBCefBrowser 实例
     */
    private static void configureContextMenu(JBCefBrowser browser) {
        boolean isDevMode = PlatformUtils.isPluginDevMode();
        browser.setProperty(JBCefBrowserBase.Properties.NO_CONTEXT_MENU, !isDevMode);
        LOG.info("Context menu " + (isDevMode ? "enabled" : "disabled") + " (devMode=" + isDevMode + ")");
    }
}
