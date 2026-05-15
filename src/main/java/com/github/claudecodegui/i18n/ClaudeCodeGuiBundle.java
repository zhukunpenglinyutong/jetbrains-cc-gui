package com.github.claudecodegui.i18n;

import com.github.claudecodegui.util.LanguageConfigService;
import com.intellij.DynamicBundle;
import org.jetbrains.annotations.Nls;
import org.jetbrains.annotations.NonNls;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.PropertyKey;

import java.text.MessageFormat;
import java.util.Locale;
import java.util.MissingResourceException;
import java.util.ResourceBundle;

/**
 * Resource bundle for CC GUI plugin localization.
 * <p>
 * This class provides access to localized strings defined in
 * messages/ClaudeCodeGuiBundle*.properties files.
 * </p>
 */
public class ClaudeCodeGuiBundle extends DynamicBundle {
    @NonNls
    private static final String BUNDLE = "messages.ClaudeCodeGuiBundle";
    private static final ClaudeCodeGuiBundle INSTANCE = new ClaudeCodeGuiBundle();

    private ClaudeCodeGuiBundle() {
        super(BUNDLE);
    }

    /**
     * Get a localized message from the bundle.
     *
     * @param key    the resource key
     * @param params optional parameters for message formatting
     * @return the localized message
     */
    @NotNull
    public static @Nls String message(@NotNull @PropertyKey(resourceBundle = BUNDLE) String key,
                                      Object @NotNull ... params) {
        Locale uiLocale = getSyncedUiLocale();
        if (uiLocale != null) {
            try {
                ResourceBundle bundle = ResourceBundle.getBundle(
                        BUNDLE,
                        uiLocale,
                        ClaudeCodeGuiBundle.class.getClassLoader()
                );
                String pattern = bundle.getString(key);
                return params.length == 0 ? pattern : new MessageFormat(pattern, uiLocale).format(params);
            } catch (MissingResourceException ignored) {
                // Fall back to IntelliJ DynamicBundle locale below.
            }
        }
        return INSTANCE.getMessage(key, params);
    }

    private static Locale getSyncedUiLocale() {
        String language = LanguageConfigService.getCurrentLanguage();
        return switch (language) {
            case "zh" -> Locale.CHINESE;
            case "zh-TW" -> Locale.TRADITIONAL_CHINESE;
            case "hi" -> new Locale("hi");
            case "es" -> new Locale("es");
            case "fr" -> Locale.FRENCH;
            case "ja" -> Locale.JAPANESE;
            case "ru" -> new Locale("ru");
            case "en" -> Locale.ENGLISH;
            default -> null;
        };
    }
}
