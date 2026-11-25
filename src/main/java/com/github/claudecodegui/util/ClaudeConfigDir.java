package com.github.claudecodegui.util;

import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.ide.util.PropertiesComponent;
import org.jetbrains.annotations.TestOnly;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.function.Supplier;
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
 * converted for file access, and {@link #forNode} converts back for the child process. A WSL node
 * ignores the IDE's {@code CLAUDE_CONFIG_DIR}: that value names the Windows Claude's directory, and
 * the Claude inside WSL keeps its own {@code ~/.claude} unless the setting says otherwise.
 */
public final class ClaudeConfigDir {

    public static final String CONFIG_DIR_PROPERTY_KEY = "claude.code.config.dir";
    public static final String ENV_VAR = "CLAUDE_CONFIG_DIR";
    private static final String DEFAULT_DIR_NAME = ".claude";
    private static final String SETTINGS_FILE_NAME = "settings.json";
    private static final String CLAUDE_JSON_FILE_NAME = ".claude.json";

    private static volatile Supplier<String> settingReader = ClaudeConfigDir::readSetting;

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

    /** The first usable explicit directory (setting, then env; setting only for a WSL node), or null for the default. */
    public static Path explicit(String configured, String envValue, String home) {
        return explicit(configured, envValue, home, false, null);
    }

    public static Path explicit(String configured, String envValue, String home,
                                boolean wslNode, UnaryOperator<String> linuxToUnc) {
        for (String candidate : wslNode ? new String[] {configured} : new String[] {configured, envValue}) {
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
        return explicit(settingReader.get(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps(),
                isWslNode(), WslPathUtil::convertWslPathToWindowsUnc);
    }

    /** Resolve at call time so a changed setting is honoured without a restart. */
    public static Path current() {
        return resolve(settingReader.get(), System.getenv(ENV_VAR), NodeDetector.resolveHomeForFileOps(),
                isWslNode(), WslPathUtil::convertWslPathToWindowsUnc);
    }

    /** {@code settings.json} of the active Claude profile: {@code <config dir>/settings.json}. */
    public static Path settingsJson() {
        return current().resolve(SETTINGS_FILE_NAME);
    }

    /**
     * The Claude CLI's global state file ({@code .claude.json}: account, MCP servers, per-project trust).
     * It sits in the home directory by default, but moves into the config directory when
     * {@code CLAUDE_CONFIG_DIR} is set, so an explicit directory takes it along.
     */
    public static Path claudeJson() {
        return claudeJson(override(), NodeDetector.resolveHomeForFileOps());
    }

    /** Pure form of {@link #claudeJson()}: {@code override} is the explicit directory, or null for the default. */
    public static Path claudeJson(Path override, String home) {
        return override != null ? override.resolve(CLAUDE_JSON_FILE_NAME) : Paths.get(home, CLAUDE_JSON_FILE_NAME);
    }

    public static boolean isWslNode() {
        return NodeDetector.isWslPath(NodeDetector.getInstance().getCachedNodePath());
    }

    /** Replaces the stored-setting lookup so tests can run without IDE services; null restores the default. */
    @TestOnly
    public static void setSettingReaderForTests(Supplier<String> reader) {
        settingReader = reader != null ? reader : ClaudeConfigDir::readSetting;
    }

    private static String readSetting() {
        try {
            return PropertiesComponent.getInstance().getValue(CONFIG_DIR_PROPERTY_KEY);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
