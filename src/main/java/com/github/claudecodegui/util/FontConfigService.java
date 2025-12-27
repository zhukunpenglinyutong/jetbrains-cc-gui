package com.github.claudecodegui.util;

import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.diagnostic.Logger;
import com.google.gson.JsonObject;

/**
 * 字体配置服务
 * 负责从 IDEA 获取编辑器字体配置并提供给 Webview
 */
public class FontConfigService {

    private static final Logger LOG = Logger.getInstance(FontConfigService.class);

    /**
     * 获取 IDEA 编辑器字体配置
     *
     * @return 包含字体配置的 JsonObject
     */
    public static JsonObject getEditorFontConfig() {
        JsonObject config = new JsonObject();

        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();

            if (scheme != null) {
                // 编辑器字体配置
                String fontName = scheme.getEditorFontName();
                int fontSize = scheme.getEditorFontSize();
                float lineSpacing = scheme.getLineSpacing();

                config.addProperty("fontFamily", fontName);
                config.addProperty("fontSize", fontSize);
                config.addProperty("lineSpacing", lineSpacing);

                LOG.info("[FontConfig] 获取 IDEA 字体配置: fontFamily=" + fontName
                        + ", fontSize=" + fontSize
                        + ", lineSpacing=" + lineSpacing);
            } else {
                // 使用默认值
                config.addProperty("fontFamily", "JetBrains Mono");
                config.addProperty("fontSize", 14);
                config.addProperty("lineSpacing", 1.2f);
                LOG.warn("[FontConfig] 无法获取 EditorColorsScheme，使用默认值");
            }
        } catch (Exception e) {
            // 发生异常时使用默认值
            config.addProperty("fontFamily", "JetBrains Mono");
            config.addProperty("fontSize", 14);
            config.addProperty("lineSpacing", 1.2f);
            LOG.error("[FontConfig] 获取字体配置失败: " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * 获取字体配置的 JSON 字符串
     *
     * @return JSON 字符串
     */
    public static String getEditorFontConfigJson() {
        return getEditorFontConfig().toString();
    }

    /**
     * 获取编辑器字体名称
     *
     * @return 字体名称
     */
    public static String getEditorFontName() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getEditorFontName();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] 获取字体名称失败: " + e.getMessage());
        }
        return "JetBrains Mono";
    }

    /**
     * 获取编辑器字体大小
     *
     * @return 字体大小
     */
    public static int getEditorFontSize() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getEditorFontSize();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] 获取字体大小失败: " + e.getMessage());
        }
        return 14;
    }

    /**
     * 获取编辑器行间距
     *
     * @return 行间距
     */
    public static float getEditorLineSpacing() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getLineSpacing();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] 获取行间距失败: " + e.getMessage());
        }
        return 1.2f;
    }
}
