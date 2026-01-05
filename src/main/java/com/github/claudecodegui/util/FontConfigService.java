package com.github.claudecodegui.util;

import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.editor.colors.FontPreferences;
import com.intellij.openapi.diagnostic.Logger;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.List;

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
                // 获取字体偏好设置，包含主字体和回落字体
                FontPreferences fontPreferences = scheme.getFontPreferences();

                // 主字体名称
                String fontName = scheme.getEditorFontName();
                int fontSize = scheme.getEditorFontSize();
                float lineSpacing = scheme.getLineSpacing();

                config.addProperty("fontFamily", fontName);
                config.addProperty("fontSize", fontSize);
                config.addProperty("lineSpacing", lineSpacing);

                // 获取回落字体列表
                List<String> effectiveFontFamilies = fontPreferences.getEffectiveFontFamilies();
                JsonArray fallbackFonts = new JsonArray();

                // 跳过第一个（主字体），添加其余的回落字体
                for (int i = 1; i < effectiveFontFamilies.size(); i++) {
                    fallbackFonts.add(effectiveFontFamilies.get(i));
                }
                config.add("fallbackFonts", fallbackFonts);

                LOG.info("[FontConfig] 获取 IDEA 字体配置: fontFamily=" + fontName
                        + ", fontSize=" + fontSize
                        + ", lineSpacing=" + lineSpacing
                        + ", fallbackFonts=" + fallbackFonts);
            } else {
                // 使用默认值
                config.addProperty("fontFamily", "JetBrains Mono");
                config.addProperty("fontSize", 14);
                config.addProperty("lineSpacing", 1.2f);
                config.add("fallbackFonts", new JsonArray());
                LOG.warn("[FontConfig] 无法获取 EditorColorsScheme，使用默认值");
            }
        } catch (Exception e) {
            // 发生异常时使用默认值
            config.addProperty("fontFamily", "JetBrains Mono");
            config.addProperty("fontSize", 14);
            config.addProperty("lineSpacing", 1.2f);
            config.add("fallbackFonts", new JsonArray());
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
