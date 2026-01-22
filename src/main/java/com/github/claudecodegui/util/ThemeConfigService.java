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
 * IDE 主题配置服务
 * 负责从 IDEA 获取当前 UI 主题信息（亮色/暗色）并提供给 Webview
 *
 * 使用 IntelliJ Platform 公开 API:
 * - JBColor.isBright() - 检测当前是否为亮色主题
 * - LafManagerListener - 监听所有主题变化事件（包括 Sync with OS）
 *
 * 参考:
 * - https://github.com/JetBrains/intellij-community/blob/master/platform/util/ui/src/com/intellij/ui/JBColor.java
 * - https://plugins.jetbrains.com/docs/intellij/themes-getting-started.html
 */
public class ThemeConfigService {

    private static final Logger LOG = Logger.getInstance(ThemeConfigService.class);

    // 主题背景色常量 - 统一管理，确保前后端一致
    public static final Color DARK_BG_COLOR = new Color(30, 30, 30);   // #1e1e1e
    public static final Color LIGHT_BG_COLOR = Color.WHITE;             // #ffffff
    public static final String DARK_BG_HEX = "#1e1e1e";
    public static final String LIGHT_BG_HEX = "#ffffff";
    private static ThemeChangeCallback themeChangeCallback = null;
    private static Boolean lastKnownIsDark = null; // 缓存上次的主题状态,用于去重
    private static boolean listenerRegistered = false;

    /**
     * 主题变化回调接口
     */
    public interface ThemeChangeCallback {
        void onThemeChanged(JsonObject themeConfig);
    }

    /**
     * 注册主题变化监听器
     * 使用 LafManagerListener 监听所有 Look and Feel 变化
     *
     * 该监听器会在以下情况触发:
     * - 用户手动切换主题 (View → Appearance → Theme)
     * - IDE 跟随 OS 主题变化 (Settings → Sync with OS enabled)
     * - 切换 Sync with OS 设置导致主题实际改变
     * - 安装或切换自定义主题
     *
     * 注意:
     * - 监听器只会注册一次(Application 级别),在整个 IDE 生命周期内有效
     * - 每次调用都会更新回调函数,支持项目关闭后重新打开的场景
     */
    public static void registerThemeChangeListener(ThemeChangeCallback callback) {
        // 总是更新回调,支持项目重新打开的场景
        // 即使 listenerRegistered = true,项目重新打开后也需要更新回调
        themeChangeCallback = callback;
        LOG.info("[ThemeConfig] Theme change callback updated");

        // 监听器只注册一次(Application 级别)
        if (listenerRegistered) {
            LOG.debug("[ThemeConfig] Listener already registered, callback updated");
            return;
        }

        listenerRegistered = true;

        try {
            // 注册到 Application 级别的 MessageBus
            // 监听器在整个 IDE 生命周期内有效,即使项目关闭重新打开也能继续工作
            ApplicationManager.getApplication().getMessageBus()
                .connect()
                .subscribe(LafManagerListener.TOPIC, new LafManagerListener() {
                    @Override
                    public void lookAndFeelChanged(LafManager source) {
                        LOG.info("[ThemeConfig] Look and Feel changed event received");

                        // 延迟执行,确保 UI 主题已经完全更新
                        // 使用 invokeLater 确保在 EDT 的下一个周期执行,此时新主题已生效
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
     * 通知前端主题变化
     * 只有当主题真正改变时才通知,避免重复通知和不必要的 UI 更新
     */
    private static void notifyThemeChange() {
        if (themeChangeCallback == null) {
            LOG.warn("[ThemeConfig] Theme callback is null, cannot notify");
            return;
        }

        try {
            JsonObject config = getIdeThemeConfig();
            boolean currentIsDark = config.get("isDark").getAsBoolean();

            // 去重:如果主题状态没有改变,则不通知
            if (lastKnownIsDark != null && lastKnownIsDark == currentIsDark) {
                LOG.debug("[ThemeConfig] Theme state unchanged (isDark=" + currentIsDark + "), skipping notification");
                return;
            }

            // 更新缓存并通知
            lastKnownIsDark = currentIsDark;
            LOG.info("[ThemeConfig] Theme changed to: " + (currentIsDark ? "DARK" : "LIGHT") + ", notifying webview");
            themeChangeCallback.onThemeChanged(config);
        } catch (Exception e) {
            LOG.error("[ThemeConfig] Failed to notify theme change: " + e.getMessage(), e);
        }
    }

    /**
     * 获取 IDE 主题配置
     *
     * 使用 IntelliJ Platform 公开 API JBColor.isBright()
     * JBColor.isBright() 返回 true 表示亮色主题，取反即为暗色主题
     *
     * @return 包含主题配置的 JsonObject,格式: {"isDark": true/false}
     */
    public static JsonObject getIdeThemeConfig() {
        JsonObject config = new JsonObject();

        try {
            // 使用 IntelliJ 公开 API 检测是否为暗色主题
            // JBColor.isBright() 返回 true 表示亮色主题，取反得到暗色主题
            boolean isDark = !JBColor.isBright();

            config.addProperty("isDark", isDark);

            LOG.debug("[ThemeConfig] Retrieved IDE theme config: isDark=" + isDark);
        } catch (Exception e) {
            // 发生异常时使用默认值（深色）
            config.addProperty("isDark", true);
            LOG.error("[ThemeConfig] Failed to get theme config, using default (dark): " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * 获取主题配置的 JSON 字符串
     * 会更新缓存的主题状态,确保后续的变化检测准确
     *
     * @return 主题配置的 JSON 字符串
     */
    public static String getIdeThemeConfigJson() {
        JsonObject config = getIdeThemeConfig();

        // 更新缓存,确保后续的变化检测准确
        // 这样在初始加载后,只有实际变化才会触发通知
        lastKnownIsDark = config.get("isDark").getAsBoolean();

        return new Gson().toJson(config);
    }

    /**
     * 获取当前 IDE 主题对应的 Swing 背景色
     * 统一的背景色获取方法，确保前后端颜色一致
     *
     * @return 当前主题的背景色（Dark: #1e1e1e, Light: #ffffff）
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
     * 获取当前 IDE 主题对应的 Hex 颜色值
     * 用于注入到 HTML 中
     *
     * @return 当前主题的背景色 Hex 值
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
