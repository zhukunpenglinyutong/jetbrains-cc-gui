package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.SessionPathUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/** Adds remote repository-name matching to a single history request. No Git network calls are made. */
public final class GitRepositorySessionMatcher implements Predicate<String> {
    private static final Logger LOG = Logger.getInstance(GitRepositorySessionMatcher.class);
    private final Map<Path, Optional<String>> repositoryNames = new HashMap<>();
    private final Map<String, Optional<Path>> directories = new HashMap<>();
    private final String projectRepositoryName;

    public GitRepositorySessionMatcher(String projectPath) {
        this.projectRepositoryName = repositoryName(projectPath);
    }

    public static boolean isEnabled(CodemossSettingsService settings) {
        try {
            return settings != null && settings.getSessionGitRepositoryMatchingEnabled();
        } catch (IOException | RuntimeException error) {
            LOG.debug("Could not read history repository matching preference", error);
            return false;
        }
    }

    public boolean hasRepository() {
        return projectRepositoryName != null;
    }

    @Override
    public boolean test(String sessionCwd) {
        return projectRepositoryName != null && projectRepositoryName.equals(repositoryName(sessionCwd));
    }

    /** Preserves pagination metadata while adding repository matches to the native cwd filter. */
    public JsonObject filterNativeThreads(JsonObject response, String cwd) {
        if (response == null || !response.has("data") || !response.get("data").isJsonArray()) {
            return response;
        }
        JsonObject result = response.deepCopy();
        JsonArray matching = new JsonArray();
        String root = SessionPathUtils.forComparison(cwd);
        for (JsonElement element : result.getAsJsonArray("data")) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject thread = element.getAsJsonObject();
            String path = thread.has("cwd") && thread.get("cwd").isJsonPrimitive()
                    ? thread.get("cwd").getAsString() : null;
            String normalizedPath = SessionPathUtils.forComparison(path);
            if (root.isEmpty() || normalizedPath.equals(root) || normalizedPath.startsWith(root + "/") || test(path)) {
                matching.add(thread);
            }
        }
        result.add("data", matching);
        return result;
    }

    private String repositoryName(String directory) {
        if (directory == null || directory.isBlank()) {
            return null;
        }
        Optional<Path> root = directories.computeIfAbsent(directory, this::findRepositoryRoot);
        return root.flatMap(path -> repositoryNames.computeIfAbsent(path,
                key -> Optional.ofNullable(readRepositoryName(key)))).orElse(null);
    }

    private Optional<Path> findRepositoryRoot(String directory) {
        try {
            Path current = Path.of(NodeDetector.toVfsPath(SessionPathUtils.normalize(directory))).toRealPath();
            if (!Files.isDirectory(current)) {
                return Optional.empty();
            }
            while (current != null) {
                // A linked worktree uses a .git file; a normal checkout uses a directory.
                if (Files.exists(current.resolve(".git"))) {
                    return Optional.of(current);
                }
                current = current.getParent();
            }
        } catch (IOException | RuntimeException ignored) {
            // Missing directories and unreadable Git metadata retain cwd-only matching.
        }
        return Optional.empty();
    }

    private String readRepositoryName(Path root) {
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder("git", "-C", root.toString(), "config", "--get-regexp", "^remote\\..*\\.url$");
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);
            for (String variable : new String[]{"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"}) {
                builder.environment().remove(variable);
            }
            builder.environment().put("GIT_OPTIONAL_LOCKS", "0");
            builder.environment().put("GIT_TERMINAL_PROMPT", "0");
            process = builder.start();
            if (!process.waitFor(2, TimeUnit.SECONDS) || process.exitValue() != 0) {
                return null;
            }
            String firstName = null;
            String remotes = new String(process.getInputStream().readNBytes(8192), StandardCharsets.UTF_8);
            for (String remote : remotes.split("\\R")) {
                String[] entry = remote.trim().split("\\s+", 2);
                if (entry.length != 2) {
                    continue;
                }
                String name = repositoryNameFromRemote(entry[1]);
                if ("remote.origin.url".equalsIgnoreCase(entry[0])) {
                    return name;
                }
                if (firstName == null) {
                    firstName = name;
                }
            }
            return firstName;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (IOException | RuntimeException ignored) {
            return null;
        } finally {
            if (process != null) {
                process.destroyForcibly();
            }
        }
    }

    static String repositoryNameFromRemote(String remote) {
        if (remote == null || remote.isBlank()) {
            return null;
        }
        String url = remote.trim().replace('\\', '/').split("[?#]", 2)[0].replaceAll("/+$", "");
        int separator = Math.max(url.lastIndexOf('/'), url.lastIndexOf(':'));
        String name = url.substring(separator + 1);
        if (name.toLowerCase(java.util.Locale.ROOT).endsWith(".git")) {
            name = name.substring(0, name.length() - 4);
        }
        return name.isBlank() ? null : name;
    }
}
