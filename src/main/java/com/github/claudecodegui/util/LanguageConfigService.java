package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.intellij.DynamicBundle;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Locale;

/**
 * 语言配置服务
 * 负责从 IDEA 获取当前语言设置并提供给 Webview
 */
public class LanguageConfigService {

    private static final Logger LOG = Logger.getInstance(LanguageConfigService.class);

    /**
     * 将 IDEA 语言代码映射到 i18n 支持的语言代码
     * IDEA 语言格式: zh_CN, en, ja, ko 等
     * i18n 支持的语言: zh, en, zh-TW, hi, es, fr, ja
     *
     * @param ideaLocale IDEA 的 Locale
     * @return i18n 语言代码
     */
    private static String mapIdeaLocaleToI18n(Locale ideaLocale) {
        if (ideaLocale == null) {
            return "en";  // 默认英文
        }

        String language = ideaLocale.getLanguage();
        String country = ideaLocale.getCountry();

        // 中文特殊处理：区分简体和繁体
        if ("zh".equals(language)) {
            if ("TW".equals(country) || "HK".equals(country)) {
                return "zh-TW";  // 繁体中文
            }
            return "zh";  // 简体中文
        }

        // 其他语言直接映射
        switch (language) {
            case "en":
                return "en";
            case "hi":
                return "hi";
            case "es":
                return "es";
            case "fr":
                return "fr";
            case "ja":
                return "ja";
            default:
                // 不支持的语言，返回英文
                LOG.info("[LanguageConfig] 不支持的语言 '" + language + "'，使用英文作为 fallback");
                return "en";
        }
    }

    /**
     * 获取 IDEA 当前语言配置
     *
     * @return 包含语言配置的 JsonObject
     */
    public static JsonObject getLanguageConfig() {
        JsonObject config = new JsonObject();

        try {
            // 获取 IDEA 当前语言设置
            Locale currentLocale = DynamicBundle.getLocale();

            // 映射到 i18n 支持的语言代码
            String i18nLanguage = mapIdeaLocaleToI18n(currentLocale);

            config.addProperty("language", i18nLanguage);
            config.addProperty("ideaLocale", currentLocale != null ? currentLocale.toString() : "en");

            LOG.info("[LanguageConfig] 获取 IDEA 语言配置: ideaLocale=" + currentLocale
                    + ", i18nLanguage=" + i18nLanguage);

        } catch (Exception e) {
            // 发生异常时使用默认值（英文）
            config.addProperty("language", "en");
            config.addProperty("ideaLocale", "en");
            LOG.error("[LanguageConfig] 获取语言配置失败，使用默认值 (en): " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * 获取语言配置的 JSON 字符串
     *
     * @return JSON 字符串
     */
    public static String getLanguageConfigJson() {
        return getLanguageConfig().toString();
    }

    /**
     * 获取当前 i18n 语言代码
     *
     * @return 语言代码 (zh, en, zh-TW, hi, es, fr, ja)
     */
    public static String getCurrentLanguage() {
        try {
            Locale currentLocale = DynamicBundle.getLocale();
            return mapIdeaLocaleToI18n(currentLocale);
        } catch (Exception e) {
            LOG.error("[LanguageConfig] 获取当前语言失败: " + e.getMessage());
            return "en";
        }
    }
}
