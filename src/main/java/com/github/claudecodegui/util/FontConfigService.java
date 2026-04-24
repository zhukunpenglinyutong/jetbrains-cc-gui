package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.editor.colors.EditorColorsManager;
import com.intellij.openapi.editor.colors.EditorColorsScheme;
import com.intellij.openapi.editor.colors.FontPreferences;
import com.intellij.openapi.diagnostic.Logger;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.awt.Font;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Base64;
import java.util.List;

/**
 * Font configuration service.
 * Retrieves the editor font configuration from IDEA and provides it to the Webview.
 */
public class FontConfigService {

    private static final Logger LOG = Logger.getInstance(FontConfigService.class);
    public static final String UI_FONT_MODE_FOLLOW_EDITOR = "followEditor";
    public static final String UI_FONT_MODE_CUSTOM_FILE = "customFile";
    public static final String UI_FONT_WARNING_CUSTOM_UNAVAILABLE = "fontUnavailable";

    private static final String UI_FONT_CUSTOM_FAMILY = "Codemoss UI Custom";
    private static final long MAX_FONT_FILE_SIZE = 5 * 1024 * 1024; // 5MB

    /** Cached font data keyed by canonical path + lastModified to avoid re-reading large font files. */
    private record CachedFontFace(String canonicalPath, long lastModified, String fontBase64, String fontFormat, String familyName) {}
    private static volatile CachedFontFace cachedFontFace;

    /**
     * Get the IDEA editor font configuration.
     *
     * @return a JsonObject containing the font configuration
     */
    public static JsonObject getEditorFontConfig() {
        JsonObject config = new JsonObject();

        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();

            if (scheme != null) {
                // Get font preferences, including the primary font and fallback fonts
                FontPreferences fontPreferences = scheme.getFontPreferences();

                // Primary font name
                String fontName = scheme.getEditorFontName();
                int fontSize = scheme.getEditorFontSize();
                float lineSpacing = scheme.getLineSpacing();

                config.addProperty("fontFamily", fontName);
                config.addProperty("fontSize", fontSize);
                config.addProperty("lineSpacing", lineSpacing);

                // Get the fallback font list
                List<String> effectiveFontFamilies = fontPreferences.getEffectiveFontFamilies();
                JsonArray fallbackFonts = new JsonArray();

                // Skip the first entry (primary font), add the remaining fallback fonts
                for (int i = 1; i < effectiveFontFamilies.size(); i++) {
                    fallbackFonts.add(effectiveFontFamilies.get(i));
                }
                config.add("fallbackFonts", fallbackFonts);

                LOG.info("[FontConfig] Retrieved IDEA font config: fontFamily=" + fontName
                        + ", fontSize=" + fontSize
                        + ", lineSpacing=" + lineSpacing
                        + ", fallbackFonts=" + fallbackFonts);
            } else {
                // Use default values
                config.addProperty("fontFamily", "JetBrains Mono");
                config.addProperty("fontSize", 14);
                config.addProperty("lineSpacing", 1.2f);
                config.add("fallbackFonts", new JsonArray());
                LOG.warn("[FontConfig] Could not get EditorColorsScheme, using defaults");
            }
        } catch (Exception e) {
            // Fall back to default values on exception
            config.addProperty("fontFamily", "JetBrains Mono");
            config.addProperty("fontSize", 14);
            config.addProperty("lineSpacing", 1.2f);
            config.add("fallbackFonts", new JsonArray());
            LOG.error("[FontConfig] Failed to get font config: " + e.getMessage(), e);
        }

        return config;
    }

    /**
     * Resolve the effective UI font config using persisted user preference and current editor typography.
     *
     * @param persistedConfig persisted UI font configuration
     * @param editorFontConfig raw IDEA editor typography
     * @return effective UI font payload for frontend application
     */
    public static JsonObject resolveUiFontConfig(JsonObject persistedConfig, JsonObject editorFontConfig) {
        JsonObject normalizedEditorConfig = normalizeEditorFontConfig(editorFontConfig);
        JsonObject normalizedPersistedConfig = normalizePersistedUiFontConfig(persistedConfig);

        String requestedMode = normalizedPersistedConfig.get("mode").getAsString();
        String editorFontFamily = normalizedEditorConfig.get("fontFamily").getAsString();

        JsonObject resolvedConfig = new JsonObject();
        resolvedConfig.addProperty("mode", requestedMode);
        if (normalizedPersistedConfig.has("customFontPath")) {
            resolvedConfig.addProperty("customFontPath", normalizedPersistedConfig.get("customFontPath").getAsString());
        }
        resolvedConfig.addProperty("fontSize", normalizedEditorConfig.get("fontSize").getAsInt());
        resolvedConfig.addProperty("lineSpacing", normalizedEditorConfig.get("lineSpacing").getAsFloat());
        resolvedConfig.add("fallbackFonts", normalizedEditorConfig.getAsJsonArray("fallbackFonts"));

        String effectiveMode = UI_FONT_MODE_FOLLOW_EDITOR;
        String resolvedFontFamily = editorFontFamily;
        String resolvedDisplayName = editorFontFamily;
        String fontBase64 = null;
        String fontFormat = null;
        String warning = null;
        String warningCode = null;

        if (UI_FONT_MODE_CUSTOM_FILE.equals(requestedMode)) {
            String customFontPath = normalizedPersistedConfig.has("customFontPath")
                    ? normalizedPersistedConfig.get("customFontPath").getAsString()
                    : null;
            ValidationResult validation = validateCustomUiFontFile(customFontPath);
            if (validation.valid()) {
                try {
                    CachedFontFace cached = loadOrCacheFontFace(customFontPath);
                    resolvedFontFamily = UI_FONT_CUSTOM_FAMILY;
                    resolvedDisplayName = cached.familyName() != null
                            ? cached.familyName()
                            : (validation.familyName() != null ? validation.familyName() : extractFileName(customFontPath));
                    fontBase64 = cached.fontBase64();
                    fontFormat = cached.fontFormat();
                    effectiveMode = UI_FONT_MODE_CUSTOM_FILE;
                } catch (Exception e) {
                    warning = "Font unavailable, currently using editor font";
                    warningCode = UI_FONT_WARNING_CUSTOM_UNAVAILABLE;
                    LOG.warn("[FontConfig] Failed to read custom font " + customFontPath + ": " + e.getMessage(), e);
                }
            } else {
                warning = "Font unavailable, currently using editor font";
                warningCode = UI_FONT_WARNING_CUSTOM_UNAVAILABLE;
            }
        }

        resolvedConfig.addProperty("effectiveMode", effectiveMode);
        resolvedConfig.addProperty("fontFamily", resolvedFontFamily);
        resolvedConfig.addProperty("displayName", resolvedDisplayName);
        if (fontBase64 != null) {
            resolvedConfig.addProperty("fontBase64", fontBase64);
            resolvedConfig.addProperty("fontFormat", fontFormat);
        }
        if (warning != null) {
            resolvedConfig.addProperty("warning", warning);
        }
        if (warningCode != null) {
            resolvedConfig.addProperty("warningCode", warningCode);
        }

        return resolvedConfig;
    }

    /**
     * Resolve the effective UI font config using persisted settings and live editor typography.
     *
     * @param settingsService settings facade
     * @return effective UI font payload
     */
    public static JsonObject getResolvedUiFontConfig(CodemossSettingsService settingsService) {
        try {
            JsonObject persistedConfig = settingsService.getUiFontConfig();
            return resolveUiFontConfig(persistedConfig, getEditorFontConfig());
        } catch (Exception e) {
            LOG.error("[FontConfig] Failed to resolve UI font config: " + e.getMessage(), e);
            return resolveUiFontConfig(null, getEditorFontConfig());
        }
    }

    /**
     * Resolve the effective UI font config and serialize it for JavaScript injection.
     *
     * @param settingsService settings facade
     * @return serialized effective UI font payload
     */
    public static String getResolvedUiFontConfigJson(CodemossSettingsService settingsService) {
        return getResolvedUiFontConfig(settingsService).toString();
    }

    /**
     * Validate a custom UI font file path.
     *
     * @param path custom font path
     * @return validation result
     */
    public static ValidationResult validateCustomUiFontFile(String path) {
        if (path == null || path.trim().isEmpty()) {
            return new ValidationResult(false, "Font path is empty", null);
        }

        String normalizedPath = path.trim();
        String lowerPath = normalizedPath.toLowerCase();
        if (!lowerPath.endsWith(".ttf") && !lowerPath.endsWith(".otf")) {
            return new ValidationResult(false, "Only TTF and OTF font files are supported", null);
        }

        File file = new File(normalizedPath);
        if (!file.exists() || !file.isFile()) {
            return new ValidationResult(false, "Font file does not exist", null);
        }

        // Resolve symlinks and relative segments to prevent path traversal
        String canonicalPath;
        try {
            canonicalPath = file.getCanonicalPath();
        } catch (Exception e) {
            return new ValidationResult(false, "Cannot resolve font file path", null);
        }
        String canonicalLower = canonicalPath.toLowerCase();
        if (!canonicalLower.endsWith(".ttf") && !canonicalLower.endsWith(".otf")) {
            return new ValidationResult(false, "Only TTF and OTF font files are supported", null);
        }

        File canonicalFile = new File(canonicalPath);
        if (!canonicalFile.canRead()) {
            return new ValidationResult(false, "Font file is not readable", null);
        }
        if (canonicalFile.length() > MAX_FONT_FILE_SIZE) {
            return new ValidationResult(false, "Font file exceeds 5MB size limit", null);
        }

        try (InputStream inputStream = new FileInputStream(canonicalFile)) {
            Font font = Font.createFont(Font.TRUETYPE_FONT, inputStream);
            return new ValidationResult(true, null, font.getFontName());
        } catch (Exception e) {
            LOG.warn("[FontConfig] Failed to validate custom font file: " + canonicalPath, e);
            return new ValidationResult(false, "Unable to parse font file", null);
        }
    }

    /**
     * Get the font configuration as a JSON string.
     *
     * @return the JSON string
     */
    public static String getEditorFontConfigJson() {
        return getEditorFontConfig().toString();
    }

    /**
     * Get the editor font name.
     *
     * @return the font name
     */
    public static String getEditorFontName() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getEditorFontName();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] Failed to get font name: " + e.getMessage());
        }
        return "JetBrains Mono";
    }

    /**
     * Get the editor font size.
     *
     * @return the font size
     */
    public static int getEditorFontSize() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getEditorFontSize();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] Failed to get font size: " + e.getMessage());
        }
        return 14;
    }

    /**
     * Get the editor line spacing.
     *
     * @return the line spacing
     */
    public static float getEditorLineSpacing() {
        try {
            EditorColorsScheme scheme = EditorColorsManager.getInstance().getGlobalScheme();
            if (scheme != null) {
                return scheme.getLineSpacing();
            }
        } catch (Exception e) {
            LOG.error("[FontConfig] Failed to get line spacing: " + e.getMessage());
        }
        return 1.2f;
    }

    private static CachedFontFace loadOrCacheFontFace(String fontPath) throws Exception {
        File file = new File(fontPath);
        String canonicalPath = file.getCanonicalPath();
        long lastModified = file.lastModified();

        CachedFontFace cached = cachedFontFace;
        if (cached != null
                && canonicalPath.equals(cached.canonicalPath())
                && lastModified == cached.lastModified()) {
            return cached;
        }

        byte[] fontBytes = Files.readAllBytes(file.toPath());
        String familyName = null;
        try (InputStream is = new java.io.ByteArrayInputStream(fontBytes)) {
            Font font = Font.createFont(Font.TRUETYPE_FONT, is);
            familyName = font.getFontName();
        } catch (Exception e) {
            LOG.debug("[FontConfig] Could not extract family name from cached read: " + e.getMessage());
        }
        String fontBase64 = Base64.getEncoder().encodeToString(fontBytes);
        String fontFormat = fontFormatForPath(fontPath);
        CachedFontFace entry = new CachedFontFace(canonicalPath, lastModified, fontBase64, fontFormat, familyName);
        cachedFontFace = entry;
        return entry;
    }

    private static JsonObject normalizeEditorFontConfig(JsonObject config) {
        return config != null ? config.deepCopy() : getEditorFontConfig();
    }

    private static JsonObject normalizePersistedUiFontConfig(JsonObject persistedConfig) {
        JsonObject normalized = new JsonObject();
        String mode = persistedConfig != null
                && persistedConfig.has("mode")
                && !persistedConfig.get("mode").isJsonNull()
                ? persistedConfig.get("mode").getAsString()
                : UI_FONT_MODE_FOLLOW_EDITOR;
        if (!UI_FONT_MODE_FOLLOW_EDITOR.equals(mode)
                && !UI_FONT_MODE_CUSTOM_FILE.equals(mode)) {
            mode = UI_FONT_MODE_FOLLOW_EDITOR;
        }

        normalized.addProperty("mode", mode);
        if (UI_FONT_MODE_CUSTOM_FILE.equals(mode)
                && persistedConfig != null
                && persistedConfig.has("customFontPath")
                && !persistedConfig.get("customFontPath").isJsonNull()
                && !persistedConfig.get("customFontPath").getAsString().trim().isEmpty()) {
            normalized.addProperty("customFontPath", persistedConfig.get("customFontPath").getAsString().trim());
        }
        return normalized;
    }

    private static String fontFormatForPath(String path) {
        return path.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
    }

    private static String extractFileName(String path) {
        return new File(path).getName();
    }

    public record ValidationResult(boolean valid, String errorMessage, String familyName) {}
}
