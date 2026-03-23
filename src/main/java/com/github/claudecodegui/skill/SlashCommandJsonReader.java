package com.github.claudecodegui.skill;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import org.snakeyaml.engine.v2.api.Load;
import org.snakeyaml.engine.v2.api.LoadSettings;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

final class SlashCommandJsonReader {

    private static final Logger LOG = Logger.getInstance(SlashCommandJsonReader.class);
    private static final long MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;

    private SlashCommandJsonReader() {
    }

    static JsonObject readJsonObject(Path path) {
        if (path == null || !Files.isRegularFile(path)) {
            return null;
        }

        try {
            long size = Files.size(path);
            if (size > MAX_JSON_FILE_SIZE) {
                LOG.warn("JSON file too large, skipping: " + path + " (" + size + " bytes)");
                return null;
            }
        } catch (IOException e) {
            return null;
        }

        try (var reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            JsonElement parsed = JsonParser.parseReader(reader);
            if (parsed != null && parsed.isJsonObject()) {
                return parsed.getAsJsonObject();
            }
        } catch (Exception e) {
            LOG.debug("Failed to read JSON: " + path);
        }

        return null;
    }

    static String extractCommandDescription(Path mdPath) {
        String yamlText = SkillFrontmatterParser.extractFrontmatter(mdPath);
        if (yamlText == null) {
            return null;
        }

        try {
            LoadSettings settings = LoadSettings.builder()
                    .setMaxAliasesForCollections(0)
                    .setCodePointLimit(8192)
                    .build();
            Load load = new Load(settings);
            Object parsed = load.loadFromString(yamlText);

            if (parsed instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> map = (Map<String, Object>) parsed;
                Object desc = map.get("description");
                return desc != null ? String.valueOf(desc).trim() : null;
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse command frontmatter: " + mdPath);
        }
        return null;
    }

    static Map<String, String> readKnownMarketplaces(String userHome) {
        Map<String, String> result = new HashMap<>();
        if (userHome == null || userHome.isEmpty()) {
            return result;
        }

        Path knownPath;
        try {
            knownPath = Paths.get(userHome, ".claude", "plugins", "known_marketplaces.json");
        } catch (Exception e) {
            return result;
        }

        JsonObject root = readJsonObject(knownPath);
        if (root == null) {
            return result;
        }

        for (String marketplaceId : root.keySet()) {
            JsonElement entry = root.get(marketplaceId);
            if (entry == null || !entry.isJsonObject()) {
                continue;
            }
            JsonElement locationElement = entry.getAsJsonObject().get("installLocation");
            if (locationElement != null && locationElement.isJsonPrimitive()) {
                String location = locationElement.getAsString();
                if (location != null && !location.trim().isEmpty()) {
                    result.put(marketplaceId, location.trim());
                }
            }
        }

        return result;
    }
}
