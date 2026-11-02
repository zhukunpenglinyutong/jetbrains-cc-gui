package com.github.claudecodegui.provider.grok;

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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves the token context window limit for Grok models from local CLI cache and configuration files.
 */
public final class GrokContextWindowResolver {

    private static final Logger LOG = Logger.getInstance(GrokContextWindowResolver.class);
    private static final int MAX_CACHED_HOMES = 16;

    private static final String SECTION_MODELS = "models";
    private static final String KEY_HIDDEN = "hidden";
    private static final String KEY_INFO = "info";


    private static final Set<String> SENTINEL_MODELS = Set.of(
            "grok", "default", "(default)", "auto",
            "__config_default__", "config-default", "config_default"
    );

    private static final Pattern SECTION_HEADER = Pattern.compile("^\\s*\\[([^\\]]+)]\\s*$");
    private static final Pattern DEFAULT_MODEL =
            Pattern.compile("^\\s*default\\s*=\\s*[\"']([^\"']+)[\"']\\s*$");
    private static final Pattern MODEL_SECTION_QUOTED =
            Pattern.compile("^model\\.\"([^\"]+)\"$|^model\\.'([^']+)'$");
    private static final Pattern MODEL_SECTION_BARE =
            Pattern.compile("^model\\.([^.\\s]+)$");

    private static final Map<Path, CachedHomeData> CACHE = new ConcurrentHashMap<>();

    private GrokContextWindowResolver() {
    }

    /**
     * Resolves the context window limit for a Grok model using candidate Grok home directories.
     *
     * @param model Model or profile identifier
     * @return context window size in tokens, or null when not declared in local Grok metadata
     */
    public static Integer resolve(String model) {
        for (Path home : candidateGrokHomes()) {
            Integer resolved = resolve(model, home);
            if (resolved != null && resolved > 0) {
                return resolved;
            }
        }
        return null;
    }

    /**
     * Resolves the context window limit for a Grok model from a specific Grok home directory.
     *
     * @param model Model or profile identifier
     * @param grokHome Path to the Grok home directory containing config.toml and models_cache.json
     * @return context window size in tokens, or null when not declared in the given directory
     */
    public static Integer resolve(String model, Path grokHome) {
        if (grokHome == null) {
            return null;
        }
        CachedHomeData data = loadHomeData(grokHome);
        if (data.modelContextWindows().isEmpty()) {
            return null;
        }

        String effective = normalizeRequestedModel(model);
        if (effective == null) {
            effective = data.defaultModel();
            if (effective == null || effective.isEmpty()) {
                effective = data.firstModelId();
            }
        }
        if (effective == null || effective.isEmpty()) {
            return null;
        }

        Integer direct = lookupWindow(data.modelContextWindows(), effective);
        if (direct != null) {
            return direct;
        }

        String mapped = data.profileToModel().get(effective);
        if (mapped != null && !mapped.isEmpty()) {
            Integer mappedWindow = lookupWindow(data.modelContextWindows(), mapped);
            if (mappedWindow != null) {
                return mappedWindow;
            }
        }
        return null;
    }

    private static List<Path> candidateGrokHomes() {
        LinkedHashSet<Path> homes = new LinkedHashSet<>();
        try {
            homes.addAll(GrokLocalAuthResolver.resolveGrokHomeCandidates());
        } catch (Exception e) {
            LOG.debug("[GrokContextWindowResolver] Failed to resolve Grok home candidates: " + e.getMessage());
        }
        try {
            String nodeHome = NodeDetector.resolveHomeForFileOps();
            if (nodeHome != null && !nodeHome.isBlank()) {
                homes.add(Paths.get(nodeHome.trim(), ".grok"));
            }
        } catch (Exception ignored) {
            // Node home is optional. Other Grok home candidates still apply.
        }
        return new ArrayList<>(homes);
    }

    private static String normalizeRequestedModel(String model) {
        if (model == null || model.isBlank()) {
            return null;
        }
        String trimmed = model.trim();
        if (SENTINEL_MODELS.contains(trimmed.toLowerCase(Locale.ROOT))) {
            return null;
        }
        return trimmed;
    }

    private static Integer lookupWindow(Map<String, Integer> windows, String modelId) {
        Integer exact = windows.get(modelId);
        if (exact != null && exact > 0) {
            return exact;
        }
        for (Map.Entry<String, Integer> entry : windows.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(modelId) && entry.getValue() != null && entry.getValue() > 0) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static CachedHomeData loadHomeData(Path grokHome) {
        Path normalizedHome = grokHome.toAbsolutePath().normalize();
        Path configPath = normalizedHome.resolve("config.toml");
        Path cachePath = normalizedHome.resolve("models_cache.json");

        FileStamp configStamp = FileStamp.of(configPath);
        FileStamp cacheStamp = FileStamp.of(cachePath);

        CachedHomeData cached = CACHE.get(normalizedHome);
        if (cached != null
                && cached.configStamp().equals(configStamp)
                && cached.cacheStamp().equals(cacheStamp)) {
            return cached;
        }

        ParsedConfig parsedConfig = configStamp.exists()
                ? parseConfigToml(configPath)
                : new ParsedConfig("", Map.of());
        ParsedModelsCache parsedCache = cacheStamp.exists()
                ? parseModelsCache(cachePath)
                : new ParsedModelsCache(Map.of(), "");

        if (CACHE.size() >= MAX_CACHED_HOMES) {
            CACHE.clear();
        }

        CachedHomeData fresh = new CachedHomeData(
                configStamp,
                cacheStamp,
                parsedConfig.defaultModel(),
                parsedConfig.profileToModel(),
                parsedCache.modelContextWindows(),
                parsedCache.firstModelId()
        );
        CACHE.put(normalizedHome, fresh);
        return fresh;
    }

    private static ParsedConfig parseConfigToml(Path configPath) {
        try {
            String text = Files.readString(configPath, StandardCharsets.UTF_8);
            if (text == null || text.isBlank()) {
                return new ParsedConfig("", Map.of());
            }
            return parseConfigLines(text.split("\\R", -1));
        } catch (Exception e) {
            LOG.debug("[GrokContextWindowResolver] Failed to parse " + configPath + ": " + e.getMessage());
            return new ParsedConfig("", Map.of());
        }
    }

    private static ParsedConfig parseConfigLines(String[] lines) {
        String defaultModel = "";
        String currentSection = "";
        Map<String, String> profileToModel = new LinkedHashMap<>();
        for (String line : lines) {
            String stripped = stripTomlComment(line);
            Matcher section = SECTION_HEADER.matcher(stripped);
            if (section.matches()) {
                currentSection = section.group(1).trim();
                continue;
            }
            defaultModel = applyConfigLine(currentSection, stripped, defaultModel, profileToModel);
        }
        return new ParsedConfig(defaultModel, Map.copyOf(profileToModel));
    }

    private static String applyConfigLine(
            String currentSection,
            String stripped,
            String defaultModel,
            Map<String, String> profileToModel) {
        if (SECTION_MODELS.equals(currentSection) || currentSection.isEmpty()) {
            return readModelsDefault(currentSection, stripped, defaultModel);
        }
        String profileName = extractProfileSectionName(currentSection);
        if (profileName == null) {
            return defaultModel;
        }
        String upstreamModel = extractTomlString(stripped, "model");
        if (upstreamModel == null) {
            upstreamModel = extractTomlString(stripped, "model_id");
        }
        if (upstreamModel != null && !upstreamModel.isEmpty()) {
            profileToModel.put(profileName, upstreamModel);
        }
        return defaultModel;
    }

    private static String readModelsDefault(String currentSection, String stripped, String defaultModel) {
        if (!SECTION_MODELS.equals(currentSection)) {
            return defaultModel;
        }
        Matcher def = DEFAULT_MODEL.matcher(stripped);
        if (def.matches()) {
            return def.group(1).trim();
        }
        return defaultModel;
    }

    private static ParsedModelsCache parseModelsCache(Path cachePath) {
        try {
            String raw = Files.readString(cachePath, StandardCharsets.UTF_8);
            JsonElement parsed = JsonParser.parseString(raw);
            if (parsed == null || !parsed.isJsonObject()) {
                return new ParsedModelsCache(Map.of(), "");
            }
            return indexModelWindows(parsed.getAsJsonObject());
        } catch (Exception e) {
            LOG.debug("[GrokContextWindowResolver] Failed to parse " + cachePath + ": " + e.getMessage());
            return new ParsedModelsCache(Map.of(), "");
        }
    }

    private static ParsedModelsCache indexModelWindows(JsonObject root) {
        JsonObject modelsObj = modelsObject(root);
        Map<String, Integer> windows = new LinkedHashMap<>();
        String firstModelId = "";
        for (Map.Entry<String, JsonElement> entry : modelsObj.entrySet()) {
            firstModelId = considerModelEntry(entry, windows, firstModelId);
        }
        if (firstModelId.isEmpty() && !windows.isEmpty()) {
            firstModelId = windows.keySet().iterator().next();
        }
        return new ParsedModelsCache(Map.copyOf(windows), firstModelId);
    }

    private static JsonObject modelsObject(JsonObject root) {
        if (root.has(SECTION_MODELS) && root.get(SECTION_MODELS).isJsonObject()) {
            return root.getAsJsonObject(SECTION_MODELS);
        }
        return root;
    }

    private static String considerModelEntry(
            Map.Entry<String, JsonElement> entry,
            Map<String, Integer> windows,
            String firstModelId) {
        String id = entry.getKey();
        JsonElement value = entry.getValue();
        if (id == null || id.isBlank() || value == null || !value.isJsonObject()) {
            return firstModelId;
        }
        int window = contextWindowOf(value.getAsJsonObject());
        if (window <= 0) {
            return firstModelId;
        }
        String modelId = id.trim();
        windows.put(modelId, window);
        if (firstModelId.isEmpty() && !isHiddenModel(value.getAsJsonObject())) {
            return modelId;
        }
        return firstModelId;
    }

    private static int contextWindowOf(JsonObject modelObj) {
        JsonObject infoObj = infoObject(modelObj);
        int window = readPositiveInt(infoObj, "context_window", "contextWindow", "max_context_tokens");
        if (window <= 0 && infoObj != modelObj) {
            return readPositiveInt(modelObj, "context_window", "contextWindow", "max_context_tokens");
        }
        return window;
    }

    private static JsonObject infoObject(JsonObject modelObj) {
        if (modelObj.has(KEY_INFO) && modelObj.get(KEY_INFO).isJsonObject()) {
            return modelObj.getAsJsonObject(KEY_INFO);
        }
        return modelObj;
    }

    private static boolean isHiddenModel(JsonObject modelObj) {
        JsonObject infoObj = infoObject(modelObj);
        return infoObj.has(KEY_HIDDEN)
                && infoObj.get(KEY_HIDDEN).isJsonPrimitive()
                && infoObj.get(KEY_HIDDEN).getAsBoolean();
    }

    private static int readPositiveInt(JsonObject obj, String... keys) {
        if (obj == null || keys == null) {
            return 0;
        }
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                int val = obj.get(key).getAsInt();
                if (val > 0) {
                    return val;
                }
            } catch (Exception ignored) {
                // Ignore a non-numeric value and try the next key.
            }
        }
        return 0;
    }

    private static String stripTomlComment(String line) {
        if (line == null) {
            return "";
        }
        boolean inSingle = false;
        boolean inDouble = false;
        int index = 0;
        while (index < line.length()) {
            char ch = line.charAt(index);
            if (ch == '\\' && (inSingle || inDouble) && index + 1 < line.length()) {
                index += 2;
                continue;
            }
            if (ch == '"' && !inSingle) {
                inDouble = !inDouble;
            } else if (ch == '\'' && !inDouble) {
                inSingle = !inSingle;
            } else if (ch == '#' && !inSingle && !inDouble) {
                return line.substring(0, index);
            }
            index++;
        }
        return line;
    }

    private static String extractProfileSectionName(String section) {
        if (section == null || section.isEmpty()) {
            return null;
        }
        Matcher q = MODEL_SECTION_QUOTED.matcher(section);
        if (q.matches()) {
            String a = q.group(1);
            String b = q.group(2);
            return a != null ? a : b;
        }
        Matcher bare = MODEL_SECTION_BARE.matcher(section);
        if (bare.matches()) {
            return bare.group(1);
        }
        return null;
    }

    private static String extractTomlString(String line, String key) {
        Pattern p = Pattern.compile("^\\s*" + Pattern.quote(key) + "\\s*=\\s*[\"']([^\"']*)[\"']\\s*$");
        Matcher m = p.matcher(line);
        if (m.matches()) {
            return m.group(1).trim();
        }
        return null;
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

    private record ParsedConfig(String defaultModel, Map<String, String> profileToModel) {
    }

    private record ParsedModelsCache(Map<String, Integer> modelContextWindows, String firstModelId) {
    }

    private record CachedHomeData(
            FileStamp configStamp,
            FileStamp cacheStamp,
            String defaultModel,
            Map<String, String> profileToModel,
            Map<String, Integer> modelContextWindows,
            String firstModelId
    ) {
    }
}
