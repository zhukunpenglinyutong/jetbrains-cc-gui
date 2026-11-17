package com.github.claudecodegui.util;

import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.ide.util.PropertiesComponent;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Resolves the Claude configuration directory the plugin reads history from.
 *
 * <p>Mirrors the Claude CLI: {@code CLAUDE_CONFIG_DIR} replaces {@code ~/.claude}. A plugin
 * setting takes precedence so a profile chosen via "Claude CLI Path (override)" can be paired
 * with its own data directory. Order: plugin setting, then the IDE's {@code CLAUDE_CONFIG_DIR},
 * then {@code ~/.claude}. A candidate that is not an absolute path after {@code ~} expansion is
 * ignored, because a relative directory would depend on each process's working directory.
 */
public final class ClaudeConfigDir {

    public static final String CONFIG_DIR_PROPERTY_KEY = "claude.code.config.dir";
    public static final String ENV_VAR = "CLAUDE_CONFIG_DIR";
    private static final String DEFAULT_DIR_NAME = ".claude";

    private ClaudeConfigDir() {
    }

    /** Expands a leading {@code ~} against {@code home}. Does not check that the result is absolute. */
    public static Path expand(String raw, String home) {
        String value = raw.trim();
        if (value.equals("~")) {
            return Paths.get(home);
        }
        if (value.startsWith("~/") || value.startsWith("~\\")) {
            return Paths.get(home, value.substring(2));
        }
        return Paths.get(value);
    }

    /** The first usable explicit directory (setting, then env), or null when the default applies. */
    public static Path explicit(String configured, String envValue, String home) {
        for (String candidate : new String[] {configured, envValue}) {
            if (candidate == null || candidate.trim().isEmpty()) {
                continue;
            }
            try {
                Path path = expand(candidate, home);
                if (path.isAbsolute()) {
                    return path;
                }
            } catch (InvalidPathException ignored) {
                // An unusable value is treated as unset.
            }
        }
        return null;
    }

    /** Pure resolution, independent of IDE services. */
    public static Path resolve(String configured, String envValue, String home) {
        Path explicit = explicit(configured, envValue, home);
        return explicit != null ? explicit : Paths.get(home, DEFAULT_DIR_NAME);
    }

    /** The explicitly chosen directory (setting, else env), or null when the default applies. */
    public static Path override() {
        return explicit(readSetting(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps());
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
}
