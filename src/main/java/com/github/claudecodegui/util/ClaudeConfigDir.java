package com.github.claudecodegui.util;

import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.ide.util.PropertiesComponent;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.function.UnaryOperator;

/**
 * Resolves the Claude configuration directory the plugin reads history from.
 *
 * <p>Mirrors the Claude CLI: {@code CLAUDE_CONFIG_DIR} replaces {@code ~/.claude}. A plugin
 * setting takes precedence so a profile chosen via "Claude CLI Path (override)" can be paired
 * with its own data directory. Order: plugin setting, then the IDE's {@code CLAUDE_CONFIG_DIR},
 * then {@code ~/.claude}. A candidate that is not an absolute path after {@code ~} expansion is
 * ignored, because a relative directory would depend on each process's working directory.
 *
 * <p>With a WSL node the same directory has two spellings. The plugin reads files through the
 * Windows UNC form ({@code \\wsl.localhost\Distro\home\me\.claude-work}), while node inside WSL
 * needs the Linux form ({@code /home/me/.claude-work}). A Linux path typed in the setting is
 * converted for file access, and {@link #forNode} converts back for the child process.
 */
public final class ClaudeConfigDir {

    public static final String CONFIG_DIR_PROPERTY_KEY = "claude.code.config.dir";
    public static final String ENV_VAR = "CLAUDE_CONFIG_DIR";
    private static final String DEFAULT_DIR_NAME = ".claude";

    private ClaudeConfigDir() {
    }

    /** Expands a leading {@code ~} against {@code home} for a native node. Does not check that the result is absolute. */
    public static Path expand(String raw, String home) {
        return expand(raw, home, false, null);
    }

    /**
     * Expands a leading {@code ~} against {@code home}. With a WSL node a Linux absolute path is
     * mapped through {@code linuxToUnc} so the plugin can open it; returns null when that mapping
     * is unavailable. Does not check that the result is absolute.
     */
    public static Path expand(String raw, String home, boolean wslNode, UnaryOperator<String> linuxToUnc) {
        String value = raw.trim();
        if (value.equals("~")) {
            return Paths.get(home);
        }
        if (value.startsWith("~/") || value.startsWith("~\\")) {
            return Paths.get(home, value.substring(2));
        }
        if (wslNode && value.startsWith("/")) {
            String unc = linuxToUnc != null ? linuxToUnc.apply(value) : null;
            return unc == null ? null : Paths.get(unc);
        }
        return Paths.get(value);
    }

    /** The first usable explicit directory (setting, then env), or null when the default applies. */
    public static Path explicit(String configured, String envValue, String home) {
        return explicit(configured, envValue, home, false, null);
    }

    public static Path explicit(String configured, String envValue, String home,
                                boolean wslNode, UnaryOperator<String> linuxToUnc) {
        for (String candidate : new String[] {configured, envValue}) {
            if (candidate == null || candidate.trim().isEmpty()) {
                continue;
            }
            try {
                Path path = expand(candidate, home, wslNode, linuxToUnc);
                if (path != null && path.isAbsolute()) {
                    return path;
                }
            } catch (InvalidPathException ignored) {
                // An unusable value is treated as unset.
            }
        }
        return null;
    }

    /** Pure resolution for a native node, independent of IDE services. */
    public static Path resolve(String configured, String envValue, String home) {
        return resolve(configured, envValue, home, false, null);
    }

    public static Path resolve(String configured, String envValue, String home,
                               boolean wslNode, UnaryOperator<String> linuxToUnc) {
        Path explicit = explicit(configured, envValue, home, wslNode, linuxToUnc);
        return explicit != null ? explicit : Paths.get(home, DEFAULT_DIR_NAME);
    }

    /** The directory as the given node process must see it: a Linux path for WSL, the file path otherwise. */
    public static String forNode(Path filePath, boolean wslNode) {
        return wslNode ? WslPathUtil.convertToWslPath(filePath.toString()) : filePath.toString();
    }

    /** The explicitly chosen directory (setting, else env) as a path the plugin can open, or null for the default. */
    public static Path override() {
        return explicit(readSetting(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps(),
                isWslNode(), WslPathUtil::convertWslPathToWindowsUnc);
    }

    /** Resolve at call time so a changed setting is honoured without a restart. */
    public static Path current() {
        return resolve(readSetting(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps(),
                isWslNode(), WslPathUtil::convertWslPathToWindowsUnc);
    }

    public static boolean isWslNode() {
        return NodeDetector.isWslPath(NodeDetector.getInstance().getCachedNodePath());
    }

    private static String readSetting() {
        try {
            return PropertiesComponent.getInstance().getValue(CONFIG_DIR_PROPERTY_KEY);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
