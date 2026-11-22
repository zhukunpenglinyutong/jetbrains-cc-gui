package com.github.claudecodegui.util;

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
        return (configuredHome == null || configuredHome.isBlank()
                ? Path.of(userHome, ".codex") : Path.of(configuredHome.trim())).toAbsolutePath().normalize();
    }
}
