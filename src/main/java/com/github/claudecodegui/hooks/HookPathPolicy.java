package com.github.claudecodegui.hooks;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Pattern;

/** Shared path checks for hook discovery and mutations. */
final class HookPathPolicy {

    private static final Pattern CONTROL_CHARACTERS = Pattern.compile("[\\u0000-\\u001f]");

    private final Path userHome;

    HookPathPolicy(Path userHome) {
        this.userHome = userHome.toAbsolutePath().normalize();
    }

    Path validateExistingTarget(Path project, String location) throws IOException {
        if (location == null || location.isBlank() || CONTROL_CHARACTERS.matcher(location).find()) {
            return null;
        }
        Path target;
        try {
            target = Paths.get(location).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
        if (!Files.isRegularFile(target) || Files.isSymbolicLink(target)) {
            return null;
        }
        if (isClaudeSettings(target, project)) {
            return target;
        }
        if (isCodexConfig(target, project)) {
            return target;
        }
        return isUnderAnyHookRoot(target, project) ? target : null;
    }

    boolean isClaudeSettings(Path target, Path project) {
        Path normalized = target.toAbsolutePath().normalize();
        if (normalized.equals(userHome.resolve(".claude/settings.json"))
                || normalized.equals(userHome.resolve(".claude/settings.local.json"))) {
            return true;
        }
        if (project == null) {
            return false;
        }
        Path projectClaude = project.resolve(".claude");
        return normalized.equals(projectClaude.resolve("settings.json"))
                || normalized.equals(projectClaude.resolve("settings.local.json"));
    }

    boolean isUnderHookRoot(Path target, Path hookRoot) throws IOException {
        if (!Files.isDirectory(hookRoot)) {
            return false;
        }
        Path realTarget = target.toRealPath();
        Path realRoot = hookRoot.toRealPath();
        return realTarget.startsWith(realRoot) && !realTarget.equals(realRoot);
    }

    boolean isCodexConfig(Path target, Path project) {
        Path normalized = target.toAbsolutePath().normalize();
        if (normalized.equals(userHome.resolve(".codex/config.toml"))) {
            return true;
        }
        return project != null && normalized.equals(project.resolve(".codex/config.toml"));
    }

    boolean isUnderAnyHookRoot(Path target, Path project) throws IOException {
        if (isUnderHookRoot(target, userHome.resolve(".codex/hooks"))
                || isUnderHookRoot(target, userHome.resolve(".codemoss/hooks"))) {
            return true;
        }
        return project != null && (isUnderHookRoot(target, project.resolve(".codex/hooks"))
                || isUnderHookRoot(target, project.resolve(".codemoss/hooks")));
    }
}
