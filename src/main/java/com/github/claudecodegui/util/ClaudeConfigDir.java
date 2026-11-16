package com.github.claudecodegui.util;

import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.ide.util.PropertiesComponent;

import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Resolves the Claude configuration directory the plugin reads history from.
 *
 * <p>Mirrors the Claude CLI: {@code CLAUDE_CONFIG_DIR} replaces {@code ~/.claude}. A plugin
 * setting takes precedence so a profile chosen via "Claude CLI Path (override)" can be paired
 * with its own data directory. Order: plugin setting, then the IDE's {@code CLAUDE_CONFIG_DIR},
 * then {@code ~/.claude}.
 */
public final class ClaudeConfigDir {

    public static final String CONFIG_DIR_PROPERTY_KEY = "claude.code.config.dir";
    public static final String ENV_VAR = "CLAUDE_CONFIG_DIR";
    private static final String DEFAULT_DIR_NAME = ".claude";

    private ClaudeConfigDir() {
    }

    /** Pure resolution, independent of IDE services. Blank values are treated as unset. */
    public static Path resolve(String configured, String envValue, String home) {
        String raw = firstNonBlank(configured, envValue);
        if (raw == null) {
            return Paths.get(home, DEFAULT_DIR_NAME);
        }
        if (raw.equals("~")) {
            return Paths.get(home);
        }
        if (raw.startsWith("~/") || raw.startsWith("~\\")) {
            return Paths.get(home, raw.substring(2));
        }
        return Paths.get(raw);
    }

    /** The explicitly chosen directory (setting, else env), or null when the default applies. */
    public static String override() {
        return firstNonBlank(readSetting(), System.getenv(ENV_VAR));
    }

    /** Resolve at call time so a changed setting is honoured without a restart. */
    public static Path current() {
        return resolve(readSetting(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps());
    }

    private static String readSetting() {
        try {
            return PropertiesComponent.getInstance().getValue(CONFIG_DIR_PROPERTY_KEY);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.trim().isEmpty()) {
            return a.trim();
        }
        if (b != null && !b.trim().isEmpty()) {
            return b.trim();
        }
        return null;
    }
}
