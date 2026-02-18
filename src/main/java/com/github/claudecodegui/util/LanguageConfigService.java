package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.intellij.DynamicBundle;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Locale;

/**
 * Language configuration service.
 * Retrieves the current language setting from IDEA and provides it to the Webview.
 */
public class LanguageConfigService {

    private static final Logger LOG = Logger.getInstance(LanguageConfigService.class);

    /**
     * Map IDEA locale codes to i18n-supported language codes.
     * IDEA locale format: zh_CN, en, ja, ko, etc.
     * Supported i18n languages: zh, en, zh-TW, hi, es, fr, ja, ru
     *
     * @param ideaLocale the IDEA Locale
     * @return the i18n language code
     */
    private static String mapIdeaLocaleToI18n(Locale ideaLocale) {
        if (ideaLocale == null) {
            return "en";  // default to English
        }

        String language = ideaLocale.getLanguage();
        String country = ideaLocale.getCountry();

        // Special handling for Chinese: distinguish Simplified and Traditional
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
            case "ru":
                return "ru";
            default:
                // Unsupported language, fall back to English
                LOG.info("[LanguageConfig] Unsupported language '" + language + "', falling back to English");
                return "en";
        }
    }

    /**
     * Get the current IDEA language configuration.
     *
     * @return a JsonObject containing the language configuration
     */
    public static JsonObject getLanguageConfig() {
        JsonObject config = new JsonObject();

        try {
            // Get the current IDEA language setting
            Locale currentLocale = DynamicBundle.getLocale();

            // Map to an i18n-supported language code
            String i18nLanguage = mapIdeaLocaleToI18n(currentLocale);

            config.addProperty("language", i18nLanguage);
            config.addProperty("ideaLocale", currentLocale != null ? currentLocale.toString() : "en");

            LOG.info("[LanguageConfig] Retrieved IDEA language config: ideaLocale=" + currentLocale
                    + ", i18nLanguage=" + i18nLanguage);

        } catch (Exception e) {
            // Fall back to English on exception
            config.addProperty("language", "en");
            config.addProperty("ideaLocale", "en");
            LOG.error("[LanguageConfig] Failed to get language config, using default (en): " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * Get the language configuration as a JSON string.
     *
     * @return the JSON string
     */
    public static String getLanguageConfigJson() {
        return getLanguageConfig().toString();
    }

    /**
     * Get the current i18n language code.
     *
     * @return the language code (zh, en, zh-TW, hi, es, fr, ja, ru)
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
