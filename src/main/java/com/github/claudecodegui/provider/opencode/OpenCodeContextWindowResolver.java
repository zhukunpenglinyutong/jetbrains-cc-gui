package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Resolves the context window an OpenCode model declares through {@code limit.context}
 * in OpenCode's own config ({@code opencode.json} / {@code opencode.jsonc}).
 *
 * <p>Mirrors {@code ai-bridge/services/opencode/config.js}: project files win over
 * the global config, and JSONC comments and trailing commas are accepted. The usage
 * display asks on every message flush, so parsed configs are kept until a candidate
 * file changes.</p>
 */
public final class OpenCodeContextWindowResolver {

    private static final Logger LOG = Logger.getInstance(OpenCodeContextWindowResolver.class);
    private static final int MAX_CACHED_LOCATIONS = 32;
    private static final Set<String> CONFIG_DEFAULT_MODELS = Set.of(
            "__config_default__", "auto", "default", "(default)", "config-default",
            "config_default", "opencode default", "opencode-default");
    private static final Map<List<Path>, CachedConfigs> CACHE = new ConcurrentHashMap<>();

    private OpenCodeContextWindowResolver() {
    }

    /**
     * @param model UI model id ({@code provider/model}); a config-default id falls back to
     *              the config's own {@code model}
     * @param cwd   session working directory for project-level config, or null
     * @return the declared context window in tokens, or null when none is declared
     */
    public static Integer resolve(String model, String cwd) {
        List<JsonObject> configs = loadConfigs(candidatePaths(cwd));
        if (configs.isEmpty()) {
            return null;
        }
        String effectiveModel = normalizeModel(model);
        if (effectiveModel == null) {
            effectiveModel = configs.stream()
                    .map(cfg -> normalizeModel(text(cfg, "model")))
                    .filter(Objects::nonNull)
                    .findFirst()
                    .orElse(null);
        }
        if (effectiveModel == null) {
            return null;
        }
        for (JsonObject cfg : configs) {
            Integer limit = lookupContextLimit(cfg, effectiveModel);
            if (limit != null) {
                return limit;
            }
        }
        return null;
    }

    static String normalizeModel(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        String trimmed = model.trim();
        return CONFIG_DEFAULT_MODELS.contains(trimmed.toLowerCase(Locale.ROOT)) ? null : trimmed;
    }

    private static List<Path> candidatePaths(String cwd) {
        List<Path> candidates = new ArrayList<>();
        if (cwd != null && !cwd.isBlank()) {
            Path cwdPath = safePath(cwd);
            if (cwdPath != null) {
                candidates.add(cwdPath.resolve("opencode.json"));
                candidates.add(cwdPath.resolve("opencode.jsonc"));
                candidates.add(cwdPath.resolve(".opencode").resolve("opencode.json"));
                candidates.add(cwdPath.resolve(".opencode").resolve("opencode.jsonc"));
            }
        }
        Path envConfig = safePath(System.getenv("OPENCODE_CONFIG"));
        if (envConfig != null) {
            candidates.add(envConfig);
        }
        addConfigDir(candidates, safePath(System.getenv("OPENCODE_CONFIG_DIR")));
        Path configBase = safePath(System.getenv("XDG_CONFIG_HOME"));
        if (configBase == null) {
            configBase = homeConfigDir();
        }
        addConfigDir(candidates, configBase == null ? null : configBase.resolve("opencode"));
        return List.copyOf(candidates);
    }

    private static Path homeConfigDir() {
        try {
            Path home = safePath(NodeDetector.resolveHomeForFileOps());
            return home == null ? null : home.resolve(".config");
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void addConfigDir(List<Path> candidates, Path dir) {
        if (dir == null) {
            return;
        }
        candidates.add(dir.resolve("opencode.json"));
        candidates.add(dir.resolve("opencode.jsonc"));
        candidates.add(dir.resolve("config.json"));
    }

    private static Path safePath(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return Paths.get(raw.trim());
        } catch (Exception e) {
            return null;
        }
    }

    private static List<JsonObject> loadConfigs(List<Path> candidates) {
        List<FileStamp> stamps = candidates.stream().map(FileStamp::of).toList();
        CachedConfigs cached = CACHE.get(candidates);
        if (cached != null && cached.stamps().equals(stamps)) {
            return cached.configs();
        }
        List<JsonObject> configs = new ArrayList<>();
        for (int i = 0; i < candidates.size(); i++) {
            JsonObject parsed = stamps.get(i).exists() ? readConfig(candidates.get(i)) : null;
            if (parsed != null) {
                configs.add(parsed);
            }
        }
        if (CACHE.size() >= MAX_CACHED_LOCATIONS) {
            CACHE.clear();
        }
        List<JsonObject> frozen = List.copyOf(configs);
        CACHE.put(candidates, new CachedConfigs(stamps, frozen));
        return frozen;
    }

    private static JsonObject readConfig(Path file) {
        try {
            JsonElement el = JsonParser.parseString(stripJsonc(Files.readString(file, StandardCharsets.UTF_8)));
            return el != null && el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            LOG.debug("[OpenCodeContextWindowResolver] Skipping unreadable config " + file + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Drop JSONC comments and trailing commas that sit outside string literals.
     * Gson's lenient mode skips comments but rejects a trailing comma in an object.
     */
    static String stripJsonc(String raw) {
        return raw == null ? "" : stripTrailingCommas(stripComments(raw));
    }

    private static String stripComments(String raw) {
        StringBuilder out = new StringBuilder(raw.length());
        int i = 0;
        while (i < raw.length()) {
            char ch = raw.charAt(i);
            if (ch == '"') {
                i = copyStringLiteral(raw, i, out);
            } else if (raw.startsWith("//", i)) {
                int end = raw.indexOf('\n', i);
                i = end < 0 ? raw.length() : end;
            } else if (raw.startsWith("/*", i)) {
                int end = raw.indexOf("*/", i + 2);
                i = end < 0 ? raw.length() : end + 2;
            } else {
                out.append(ch);
                i++;
            }
        }
        return out.toString();
    }

    private static String stripTrailingCommas(String text) {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char ch = text.charAt(i);
            if (ch == '"') {
                i = copyStringLiteral(text, i, out);
                continue;
            }
            if (ch != ',' || !closesAfterWhitespace(text, i + 1)) {
                out.append(ch);
            }
            i++;
        }
        return out.toString();
    }

    private static boolean closesAfterWhitespace(String text, int from) {
        int j = from;
        while (j < text.length() && Character.isWhitespace(text.charAt(j))) {
            j++;
        }
        return j < text.length() && (text.charAt(j) == '}' || text.charAt(j) == ']');
    }

    /** Copy the string literal opening at {@code start}; return the index after its closing quote. */
    private static int copyStringLiteral(String src, int start, StringBuilder out) {
        out.append('"');
        int i = start + 1;
        while (i < src.length()) {
            char ch = src.charAt(i++);
            out.append(ch);
            if (ch == '\\' && i < src.length()) {
                out.append(src.charAt(i++));
            } else if (ch == '"') {
                break;
            }
        }
        return i;
    }

    private static Integer lookupContextLimit(JsonObject config, String effectiveModel) {
        JsonObject providers = object(config, "provider");
        if (providers == null) {
            providers = object(config, "providers");
        }
        if (providers == null) {
            return null;
        }
        int slashIdx = effectiveModel.indexOf('/');
        String providerId = slashIdx > 0 ? effectiveModel.substring(0, slashIdx) : null;
        String modelId = slashIdx > 0 ? effectiveModel.substring(slashIdx + 1) : effectiveModel;

        Integer direct = providerId == null ? null : readLimit(object(providers, providerId), modelId, effectiveModel);
        if (direct != null) {
            return direct;
        }
        for (String key : providers.keySet()) {
            Integer candidate = readLimit(object(providers, key), effectiveModel, modelId);
            if (candidate != null) {
                return candidate;
            }
        }
        return null;
    }

    private static Integer readLimit(JsonObject provider, String... modelKeys) {
        JsonObject models = object(provider, "models");
        if (models == null) {
            return null;
        }
        for (String key : modelKeys) {
            JsonObject limit = object(object(models, key), "limit");
            if (limit != null && limit.has("context") && limit.get("context").isJsonPrimitive()) {
                try {
                    int context = limit.get("context").getAsInt();
                    if (context > 0) {
                        return context;
                    }
                } catch (RuntimeException ignored) {
                    // A non-numeric limit is treated as undeclared.
                }
            }
        }
        return null;
    }

    private static JsonObject object(JsonObject parent, String key) {
        if (parent == null || key == null || !parent.has(key) || !parent.get(key).isJsonObject()) {
            return null;
        }
        return parent.getAsJsonObject(key);
    }

    private static String text(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || !obj.get(key).isJsonPrimitive()) {
            return null;
        }
        return obj.get(key).getAsString();
    }

    private record FileStamp(boolean exists, long modifiedMillis, long size) {
        static FileStamp of(Path path) {
            try {
                BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class);
                return attrs.isRegularFile()
                        ? new FileStamp(true, attrs.lastModifiedTime().toMillis(), attrs.size())
                        : new FileStamp(false, 0L, 0L);
            } catch (IOException | RuntimeException e) {
                return new FileStamp(false, 0L, 0L);
            }
        }
    }

    private record CachedConfigs(List<FileStamp> stamps, List<JsonObject> configs) {
    }
}
