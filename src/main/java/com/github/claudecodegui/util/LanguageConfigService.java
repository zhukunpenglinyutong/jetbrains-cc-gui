package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.DynamicBundle;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.util.Locale;
import java.util.Set;

/**
 * Language configuration service.
 * Retrieves the current language setting from IDEA and provides it to the Webview.
 * Also supports saving user's manual language preference, which takes priority over IDEA's language.
 */
public class LanguageConfigService {

    private static final Logger LOG = Logger.getInstance(LanguageConfigService.class);
    private static final Set<String> SUPPORTED_LANGUAGES = Set.of(
            "zh", "en", "zh-TW", "hi", "es", "fr", "ja", "ru", "ko", "pt-BR"
    );

    /**
     * Map IDEA locale codes to i18n-supported language codes.
     * IDEA locale format: zh_CN, en, ja, ko, etc.
     * Supported i18n languages: zh, en, zh-TW, hi, es, fr, ja, ru, ko, pt-BR
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
            case "ko":
                return "ko";
            case "pt":
                return "pt-BR";  // Portuguese -> Brazilian Portuguese
            default:
                // Unsupported language, fall back to English
                LOG.info("[LanguageConfig] Unsupported language '" + language + "', falling back to English");
                return "en";
        }
    }

    /**
     * Get user's manually set language preference.
     *
     * @return the user's language preference, or null if not manually set
     */
    public static String getUserLanguage(CodemossSettingsService settingsService) {
        if (settingsService == null) {
            return null;
        }
        try {
            String userLanguage = settingsService.getUserLanguage();
            if (userLanguage == null || userLanguage.isEmpty()) {
                return null;
            }
            if (!SUPPORTED_LANGUAGES.contains(userLanguage)) {
                LOG.warn("[LanguageConfig] Ignoring unsupported user language in ~/.codemoss/config.json: " + userLanguage);
                return null;
            }
            LOG.info("[LanguageConfig] User manually set language: " + userLanguage);
            return userLanguage;
        } catch (Exception e) {
            LOG.warn("[LanguageConfig] Failed to read user language from ~/.codemoss/config.json: " + e.getMessage());
            return null;
        }
    }

    /**
     * Set user's manual language preference.
     *
     * @param language the language code to save
     */
    public static void setUserLanguage(CodemossSettingsService settingsService, String language) throws IOException {
        if (settingsService == null) {
            throw new IllegalArgumentException("settingsService must not be null");
        }
        if (language == null || !SUPPORTED_LANGUAGES.contains(language.trim())) {
            throw new IllegalArgumentException("Unsupported language: " + language);
        }
        settingsService.setUserLanguage(language.trim());
        LOG.info("[LanguageConfig] Saved user language preference: " + language);
    }

    /**
     * Clear user's manual language preference (reset to follow IDEA language).
     */
    public static void clearUserLanguage(CodemossSettingsService settingsService) throws IOException {
        if (settingsService == null) {
            throw new IllegalArgumentException("settingsService must not be null");
        }
        settingsService.clearUserLanguage();
        LOG.info("[LanguageConfig] Cleared user language preference, will follow IDEA language");
    }

    /**
     * Get the current language configuration.
     * If user has manually set a language, use that; otherwise use IDEA's language.
     *
     * @return a JsonObject containing the language configuration
     */
    public static JsonObject getLanguageConfig(CodemossSettingsService settingsService) {
        JsonObject config = new JsonObject();

        try {
            // Check if user has manually set a language preference
            String userLanguage = getUserLanguage(settingsService);

            if (userLanguage != null && !userLanguage.isEmpty()) {
                // Use user's manual language preference
                config.addProperty("language", userLanguage);
                config.addProperty("source", "user");
                config.addProperty("ideaLocale", "");

                LOG.info("[LanguageConfig] Using user's manual language: " + userLanguage);
            } else {
                // Use IDEA's language setting
                Locale currentLocale = DynamicBundle.getLocale();
                String i18nLanguage = mapIdeaLocaleToI18n(currentLocale);

                config.addProperty("language", i18nLanguage);
                config.addProperty("source", "idea");
                config.addProperty("ideaLocale", currentLocale.toString());

                LOG.info("[LanguageConfig] Using IDEA language config: ideaLocale=" + currentLocale
                        + ", i18nLanguage=" + i18nLanguage);
            }

        } catch (Exception e) {
            // Fall back to English on exception
            config.addProperty("language", "en");
            config.addProperty("source", "fallback");
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
    public static String getLanguageConfigJson(CodemossSettingsService settingsService) {
        return getLanguageConfig(settingsService).toString();
    }

    /**
     * Get the current i18n language code.
     *
     * @return the language code (zh, en, zh-TW, hi, es, fr, ja, ru, ko, pt-BR)
     */
    public static String getCurrentLanguage(CodemossSettingsService settingsService) {
        String userLanguage = getUserLanguage(settingsService);
        if (userLanguage != null && !userLanguage.isEmpty()) {
            return userLanguage;
        }
        try {
            Locale currentLocale = DynamicBundle.getLocale();
            return mapIdeaLocaleToI18n(currentLocale);
        } catch (Exception e) {
            LOG.error("[LanguageConfig] Failed to get current language: " + e.getMessage());
            return "en";
        }
    }
}
