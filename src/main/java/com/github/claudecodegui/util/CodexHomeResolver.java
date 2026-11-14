package com.github.claudecodegui.util;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;

import java.nio.file.Path;

/** Uses the same native data/config home as the Codex CLI. */
public final class CodexHomeResolver {
    private CodexHomeResolver() {
    }

    public static Path resolve() {
        return resolve(System.getenv("CODEX_HOME"), NodeDetector.resolveHomeForFileOps());
    }

    public static Path resolve(String configuredHome, String userHome) {
        if (configuredHome == null || configuredHome.isBlank()) {
            return Path.of(userHome, ".codex").toAbsolutePath().normalize();
        }
        String home = configuredHome.trim();
        String windowsHome = EnvironmentConfigurator.convertWslMountPathToWindowsPath(home);
        return Path.of(windowsHome != null ? windowsHome : home).toAbsolutePath().normalize();
    }
}
