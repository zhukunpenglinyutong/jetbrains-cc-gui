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
import java.util.function.Predicate;

/** Matches full remote repository identities using local Git configuration without spawning Git. */
public final class GitRepositorySessionMatcher implements Predicate<String> {
    private static final Logger LOG = Logger.getInstance(GitRepositorySessionMatcher.class);
    private final Map<Path, Optional<String>> repositoryIdentities = new HashMap<>();
    private final Map<String, Optional<Path>> directories = new HashMap<>();
    private final String projectRepositoryIdentity;
    private final Path homeBoundary;

    public GitRepositorySessionMatcher(String projectPath) {
        this(projectPath, Path.of(NodeDetector.resolveHomeForFileOps()));
    }

    GitRepositorySessionMatcher(String projectPath, Path homeDirectory) {
        Path boundary;
        try {
            boundary = homeDirectory.toRealPath();
        } catch (IOException error) {
            boundary = homeDirectory.toAbsolutePath().normalize();
        }
        this.homeBoundary = boundary;
        this.projectRepositoryIdentity = repositoryIdentity(projectPath);
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
        return projectRepositoryIdentity != null;
    }

    @Override
    public boolean test(String sessionCwd) {
        return projectRepositoryIdentity != null && projectRepositoryIdentity.equals(repositoryIdentity(sessionCwd));
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
            boolean cwdMatch = root.isEmpty() || normalizedPath.equals(root) || normalizedPath.startsWith(root + "/");
            if (cwdMatch || test(path)) {
                thread.addProperty("requiresCwdConfirmation", !cwdMatch);
                matching.add(thread);
            }
        }
        result.add("data", matching);
        return result;
    }

    private String repositoryIdentity(String directory) {
        if (directory == null || directory.isBlank()) {
            return null;
        }
        Optional<Path> root = directories.computeIfAbsent(directory, this::findRepositoryRoot);
        return root.flatMap(path -> repositoryIdentities.computeIfAbsent(path,
                key -> Optional.ofNullable(readRepositoryIdentity(key)))).orElse(null);
    }

    private Optional<Path> findRepositoryRoot(String directory) {
        try {
            Path current = Path.of(NodeDetector.toVfsPath(SessionPathUtils.normalize(directory))).toRealPath();
            if (!Files.isDirectory(current)) {
                return Optional.empty();
            }
            Path start = current;
            while (current != null) {
                // Do not inherit a home-level dotfiles repository for unrelated projects.
                if (current.equals(homeBoundary) && !current.equals(start)) {
                    break;
                }
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

    private static final long CACHE_TTL_MS = 30_000L;
    private static final java.util.concurrent.ConcurrentHashMap<Path, CachedRemote> REMOTE_CACHE =
            new java.util.concurrent.ConcurrentHashMap<>();

    private record CachedRemote(long loadedAt, java.nio.file.attribute.FileTime modified, long size, String identity) { }

    private String readRepositoryIdentity(Path root) {
        try {
            Path git = root.resolve(".git");
            if (Files.isRegularFile(git)) {
                String pointer = Files.readString(git).trim();
                if (!pointer.startsWith("gitdir:")) {
                    return null;
                }
                git = root.resolve(pointer.substring(7).trim()).normalize();
            }
            Path common = git.resolve("commondir");
            if (Files.isRegularFile(common)) {
                git = git.resolve(Files.readString(common).trim()).normalize();
            }
            Path config = git.resolve("config").toAbsolutePath().normalize();
            var attributes = Files.readAttributes(config, java.nio.file.attribute.BasicFileAttributes.class);
            long now = System.currentTimeMillis();
            CachedRemote cached = REMOTE_CACHE.get(config);
            if (cached != null && now - cached.loadedAt() < CACHE_TTL_MS
                    && cached.modified().equals(attributes.lastModifiedTime()) && cached.size() == attributes.size()) {
                return cached.identity();
            }
            String identity = readRemoteConfig(config);
            if (REMOTE_CACHE.size() > 1024) {
                REMOTE_CACHE.clear();
            }
            REMOTE_CACHE.put(config, new CachedRemote(now, attributes.lastModifiedTime(), attributes.size(), identity));
            return identity;
        } catch (IOException | RuntimeException ignored) {
            return null;
        }
    }

    private static String readRemoteConfig(Path config) throws IOException {
        String remote = null;
        String first = null;
        var remoteSection = java.util.regex.Pattern.compile("(?i)\\[remote\\s+\"([^\"]+)\"\\]\\s*(?:[#;].*)?");
        for (String raw : Files.readAllLines(config, StandardCharsets.UTF_8)) {
            String line = raw.trim();
            if (line.startsWith("[")) {
                var match = remoteSection.matcher(line);
                remote = match.matches() ? match.group(1) : null;
                continue;
            }
            if (remote == null || !line.matches("(?i)url\\s*=.*")) {
                continue;
            }
            String value = line.substring(line.indexOf('=') + 1).trim();
            if (value.startsWith("\"") && value.endsWith("\"")) {
                value = value.substring(1, value.length() - 1);
            }
            String identity = repositoryIdentityFromRemote(value);
            if ("origin".equals(remote)) {
                return identity;
            }
            if (first == null) {
                first = identity;
            }
        }
        return first;
    }

    /** Full remote identity; user credentials and transport do not affect the repository. */
    static String repositoryIdentityFromRemote(String remote) {
        if (remote == null || remote.isBlank()) {
            return null;
        }
        String value = remote.trim();
        try {
            if (!value.contains("://")) {
                var scp = java.util.regex.Pattern.compile("(?:[^@/]+@)?([^/:]+):(.+)").matcher(value);
                if (!scp.matches()) {
                    return null;
                }
                value = "ssh://" + scp.group(1) + "/" + scp.group(2);
            }
            java.net.URI uri = new java.net.URI(value);
            String host = uri.getHost();
            String scheme = uri.getScheme();
            if (host == null || scheme == null || !java.util.Set.of("https", "http", "ssh", "git")
                    .contains(scheme.toLowerCase(java.util.Locale.ROOT))) {
                return null;
            }
            String path = uri.getPath().replaceAll("^/+|/+$", "");
            if (path.toLowerCase(java.util.Locale.ROOT).endsWith(".git")) {
                path = path.substring(0, path.length() - 4);
            }
            if (path.isBlank() || java.util.Arrays.stream(path.split("/"))
                    .anyMatch(part -> part.isBlank() || part.equals(".") || part.equals(".."))) {
                return null;
            }
            if (host.equalsIgnoreCase("github.com")) {
                path = path.toLowerCase(java.util.Locale.ROOT);
            }
            int port = uri.getPort();
            boolean standard = port == -1 || scheme.equalsIgnoreCase("ssh") && port == 22
                    || scheme.equalsIgnoreCase("https") && port == 443 || scheme.equalsIgnoreCase("http") && port == 80
                    || scheme.equalsIgnoreCase("git") && port == 9418;
            return host.toLowerCase(java.util.Locale.ROOT) + (standard ? "" : ":" + port) + "/" + path;
        } catch (java.net.URISyntaxException | RuntimeException ignored) {
            return null;
        }
    }
}
