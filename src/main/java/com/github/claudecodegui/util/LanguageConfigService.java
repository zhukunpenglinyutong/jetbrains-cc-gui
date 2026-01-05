package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.intellij.DynamicBundle;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Locale;

/**
 * Language Configuration Service
 * Detects IntelliJ IDEA's language setting and provides it to the webview for auto-locale selection
 */
public class LanguageConfigService {

    private static final Logger LOG = Logger.getInstance(LanguageConfigService.class);

    /**
     * Map IDEA locale to i18n-supported language codes
     * IDEA locale format: zh_CN, en, ja, ko, etc.
     * i18n supported languages: zh, en, zh-TW, hi, es, fr, ja
     *
     * @param ideaLocale IDEA's Locale
     * @return i18n language code
     */
    private static String mapIdeaLocaleToI18n(Locale ideaLocale) {
        if (ideaLocale == null) {
            return "en";  // Default to English
        }

        String language = ideaLocale.getLanguage();
        String country = ideaLocale.getCountry();

        // Chinese: distinguish simplified and traditional
        if ("zh".equals(language)) {
            if ("TW".equals(country) || "HK".equals(country)) {
                return "zh-TW";  // Traditional Chinese
            }
            return "zh";  // Simplified Chinese
        }

        // Direct mapping for other languages
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
                // Unsupported language, fallback to English
                LOG.info("[LanguageConfig] Unsupported language '" + language + "', using English as fallback");
                return "en";
        }
    }

    /**
     * Get IDEA's current language configuration
     *
     * @return JsonObject containing language configuration
     */
    public static JsonObject getLanguageConfig() {
        JsonObject config = new JsonObject();

        try {
            // Get IDEA's current language setting
            Locale currentLocale = DynamicBundle.getLocale();

            // Map to i18n-supported language code
            String i18nLanguage = mapIdeaLocaleToI18n(currentLocale);

            config.addProperty("language", i18nLanguage);
            config.addProperty("ideaLocale", currentLocale != null ? currentLocale.toString() : "en");

            LOG.info("[LanguageConfig] Retrieved IDEA language config: ideaLocale=" + currentLocale
                    + ", i18nLanguage=" + i18nLanguage);

        } catch (Exception e) {
            // Use default (English) on exception
            config.addProperty("language", "en");
            config.addProperty("ideaLocale", "en");
            LOG.error("[LanguageConfig] Failed to get language config, using default (en): " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * Get language configuration as JSON string
     *
     * @return JSON string
     */
    public static String getLanguageConfigJson() {
        return getLanguageConfig().toString();
    }

    /**
     * Get current i18n language code
     *
     * @return Language code (zh, en, zh-TW, hi, es, fr, ja)
     */
    public static String getCurrentLanguage() {
        try {
            Locale currentLocale = DynamicBundle.getLocale();
            return mapIdeaLocaleToI18n(currentLocale);
        } catch (Exception e) {
            LOG.error("[LanguageConfig] Failed to get current language: " + e.getMessage());
            return "en";
        }
    }
}
