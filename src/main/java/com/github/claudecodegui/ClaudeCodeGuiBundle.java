package com.github.claudecodegui;

import com.intellij.DynamicBundle;
import org.jetbrains.annotations.Nls;
import org.jetbrains.annotations.NonNls;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.PropertyKey;

/**
 * Resource bundle for Claude Code GUI plugin localization.
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
        return INSTANCE.getMessage(key, params);
    }
}
