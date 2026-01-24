package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Codex Settings Manager
 * Manages ~/.codex/config.toml and ~/.codex/auth.json files
 */
public class CodexSettingsManager {
    private static final Logger LOG = Logger.getInstance(CodexSettingsManager.class);

    private final Gson gson;
    private final Path codexDir;

    public CodexSettingsManager(Gson gson) {
        this.gson = gson;
        String userHome = System.getProperty("user.home");
        this.codexDir = Paths.get(userHome, ".codex");
    }

    /**
     * Ensure ~/.codex directory exists
     */
    public void ensureCodexDirectory() throws IOException {
        if (!Files.exists(codexDir)) {
            Files.createDirectories(codexDir);
            LOG.info("[CodexSettingsManager] Created ~/.codex directory");
        }
    }

    /**
     * Get path to config.toml
     */
    public Path getConfigTomlPath() {
        return codexDir.resolve("config.toml");
    }

    /**
     * Get path to auth.json
     */
    public Path getAuthJsonPath() {
        return codexDir.resolve("auth.json");
    }

    /**
     * Read config.toml as a map structure
     * Returns null if file doesn't exist
     */
    public Map<String, Object> readConfigToml() throws IOException {
        Path configPath = getConfigTomlPath();
        if (!Files.exists(configPath)) {
            LOG.info("[CodexSettingsManager] config.toml not found at: " + configPath);
            return null;
        }

        try {
            String content = Files.readString(configPath, StandardCharsets.UTF_8);
            return parseToml(content);
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read config.toml: " + e.getMessage());
            throw new IOException("Failed to read config.toml: " + e.getMessage(), e);
        }
    }

    /**
     * Write config.toml from a map structure
     */
    public void writeConfigToml(Map<String, Object> config) throws IOException {
        Path configPath = getConfigTomlPath();

        String tomlContent = generateToml(config);
        writeStringAtomically(configPath, tomlContent);
        LOG.info("[CodexSettingsManager] Wrote config.toml to: " + configPath);
    }

    /**
     * Write config.toml from raw string content
     */
    public void writeConfigTomlRaw(String content) throws IOException {
        Path configPath = getConfigTomlPath();

        writeStringAtomically(configPath, content);
        LOG.info("[CodexSettingsManager] Wrote raw config.toml to: " + configPath);
    }

    /**
     * Read auth.json
     */
    public JsonObject readAuthJson() throws IOException {
        Path authPath = getAuthJsonPath();
        if (!Files.exists(authPath)) {
            LOG.info("[CodexSettingsManager] auth.json not found at: " + authPath);
            return null;
        }

        try (Reader reader = Files.newBufferedReader(authPath, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[CodexSettingsManager] Failed to read auth.json: " + e.getMessage());
            throw new IOException("Failed to read auth.json: " + e.getMessage(), e);
        }
    }

    /**
     * Write auth.json
     */
    public void writeAuthJson(JsonObject auth) throws IOException {
        Path authPath = getAuthJsonPath();

        writeStringAtomically(authPath, gson.toJson(auth));
        LOG.info("[CodexSettingsManager] Wrote auth.json to: " + authPath);
    }

    /**
     * Apply provider configuration to ~/.codex files
     * @param provider The provider configuration containing config and auth data
     */
    public void applyProviderToCodexSettings(JsonObject provider) throws IOException {
        if (provider == null) {
            LOG.warn("[CodexSettingsManager] Cannot apply null provider");
            return;
        }

        // Check if provider has configToml (raw string format)
        if (provider.has("configToml") && provider.get("configToml").isJsonPrimitive()) {
            String configTomlContent = provider.get("configToml").getAsString();
            writeConfigTomlRaw(configTomlContent);
        }

        // Check if provider has authJson (raw string format)
        if (provider.has("authJson") && provider.get("authJson").isJsonPrimitive()) {
            String authJsonContent = provider.get("authJson").getAsString();
            if (authJsonContent != null && !authJsonContent.trim().isEmpty()) {
                try {
                    JsonObject authObj = JsonParser.parseString(authJsonContent).getAsJsonObject();
                    writeAuthJson(authObj);
                } catch (Exception e) {
                    LOG.warn("[CodexSettingsManager] Failed to parse authJson: " + e.getMessage());
                }
            }
        }

        String providerId = provider.has("id") ? provider.get("id").getAsString() : "unknown";
        LOG.info("[CodexSettingsManager] Applied provider to ~/.codex: " + providerId);
    }

    /**
     * Atomic write helper: write to a temp file in the same directory, then replace the target.
     * Prevents consumers (e.g., Codex SDK/CLI) from observing a partially written file.
     */
    private void writeStringAtomically(Path target, String content) throws IOException {
        ensureCodexDirectory();

        Path parent = target.getParent();
        if (parent == null) {
            // Should never happen for ~/.codex/{config.toml,auth.json}
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return;
        }

        String prefix = target.getFileName() != null ? target.getFileName().toString() : "codex";
        Path tmp = Files.createTempFile(parent, prefix, ".tmp");
        try {
            Files.writeString(tmp, content, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Get current Codex configuration (combined from config.toml and auth.json)
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        JsonObject result = new JsonObject();

        // Read config.toml
        Map<String, Object> configToml = readConfigToml();
        if (configToml != null) {
            result.add("config", mapToJsonObject(configToml));
        }

        // Read auth.json
        JsonObject authJson = readAuthJson();
        if (authJson != null) {
            result.add("auth", authJson);
        }

        return result;
    }

    // ==================== TOML Parsing Utilities ====================

    /**
     * Simple TOML parser (handles basic key=value and [section] syntax)
     */
    private Map<String, Object> parseToml(String content) {
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> currentSection = result;
        String currentSectionName = null;

        String[] lines = content.split("\n");
        for (String line : lines) {
            line = line.trim();

            // Skip empty lines and comments
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            // Section header [section] or [section.subsection]
            if (line.startsWith("[") && line.endsWith("]")) {
                String sectionName = line.substring(1, line.length() - 1).trim();
                currentSectionName = sectionName;

                // Navigate/create nested sections
                String[] parts = sectionName.split("\\.");
                currentSection = result;
                for (String part : parts) {
                    if (!currentSection.containsKey(part)) {
                        currentSection.put(part, new LinkedHashMap<String, Object>());
                    }
                    Object next = currentSection.get(part);
                    if (next instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> nextMap = (Map<String, Object>) next;
                        currentSection = nextMap;
                    }
                }
                continue;
            }

            // Key = value
            int eqIndex = line.indexOf('=');
            if (eqIndex > 0) {
                String key = line.substring(0, eqIndex).trim();
                String valueStr = line.substring(eqIndex + 1).trim();
                Object value = parseTomlValue(valueStr);
                currentSection.put(key, value);
            }
        }

        return result;
    }

    /**
     * Parse a TOML value string
     */
    private Object parseTomlValue(String valueStr) {
        if (valueStr.isEmpty()) {
            return "";
        }

        // Boolean
        if (valueStr.equals("true")) {
            return true;
        }
        if (valueStr.equals("false")) {
            return false;
        }

        // Array: [value1, value2, ...]
        if (valueStr.startsWith("[") && valueStr.endsWith("]")) {
            return parseTomlArray(valueStr);
        }

        // Inline table: { key = "value", ... }
        if (valueStr.startsWith("{") && valueStr.endsWith("}")) {
            return parseTomlInlineTable(valueStr);
        }

        // String (quoted)
        if ((valueStr.startsWith("\"") && valueStr.endsWith("\"")) ||
            (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
            return unescapeTomlString(valueStr.substring(1, valueStr.length() - 1));
        }

        // Number
        try {
            if (valueStr.contains(".")) {
                return Double.parseDouble(valueStr);
            } else {
                return Long.parseLong(valueStr);
            }
        } catch (NumberFormatException ignored) {
        }

        // Default: treat as unquoted string
        return valueStr;
    }

    /**
     * Parse a TOML array: [value1, value2, ...]
     */
    private List<Object> parseTomlArray(String arrayStr) {
        List<Object> result = new ArrayList<>();
        String content = arrayStr.substring(1, arrayStr.length() - 1).trim();

        if (content.isEmpty()) {
            return result;
        }

        // Split by comma, respecting quotes and nested structures
        List<String> elements = splitTomlElements(content, ',');
        for (String element : elements) {
            element = element.trim();
            if (!element.isEmpty()) {
                result.add(parseTomlValue(element));
            }
        }
        return result;
    }

    /**
     * Parse a TOML inline table: { key = "value", ... }
     */
    private Map<String, Object> parseTomlInlineTable(String tableStr) {
        Map<String, Object> result = new LinkedHashMap<>();
        String content = tableStr.substring(1, tableStr.length() - 1).trim();

        if (content.isEmpty()) {
            return result;
        }

        // Split by comma, respecting quotes and nested structures
        List<String> pairs = splitTomlElements(content, ',');
        for (String pair : pairs) {
            pair = pair.trim();
            int eqIndex = pair.indexOf('=');
            if (eqIndex > 0) {
                String key = pair.substring(0, eqIndex).trim();
                String valueStr = pair.substring(eqIndex + 1).trim();
                // Remove quotes from key if present
                if ((key.startsWith("\"") && key.endsWith("\"")) ||
                    (key.startsWith("'") && key.endsWith("'"))) {
                    key = key.substring(1, key.length() - 1);
                }
                result.put(key, parseTomlValue(valueStr));
            }
        }
        return result;
    }

    /**
     * Split TOML elements by delimiter, respecting quotes and nested structures
     */
    private List<String> splitTomlElements(String content, char delimiter) {
        List<String> result = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        int depth = 0;
        boolean inDoubleQuote = false;
        boolean inSingleQuote = false;
        boolean escaped = false;

        for (int i = 0; i < content.length(); i++) {
            char c = content.charAt(i);

            if (escaped) {
                current.append(c);
                escaped = false;
                continue;
            }

            if (c == '\\') {
                current.append(c);
                escaped = true;
                continue;
            }

            if (c == '"' && !inSingleQuote) {
                inDoubleQuote = !inDoubleQuote;
                current.append(c);
                continue;
            }

            if (c == '\'' && !inDoubleQuote) {
                inSingleQuote = !inSingleQuote;
                current.append(c);
                continue;
            }

            if (!inDoubleQuote && !inSingleQuote) {
                if (c == '[' || c == '{') {
                    depth++;
                } else if (c == ']' || c == '}') {
                    depth--;
                } else if (c == delimiter && depth == 0) {
                    result.add(current.toString());
                    current = new StringBuilder();
                    continue;
                }
            }

            current.append(c);
        }

        if (current.length() > 0) {
            result.add(current.toString());
        }

        return result;
    }

    /**
     * Unescape TOML string (handle \n, \t, \\, \", etc.)
     */
    private String unescapeTomlString(String str) {
        StringBuilder result = new StringBuilder();
        boolean escaped = false;

        for (int i = 0; i < str.length(); i++) {
            char c = str.charAt(i);
            if (escaped) {
                switch (c) {
                    case 'n': result.append('\n'); break;
                    case 't': result.append('\t'); break;
                    case 'r': result.append('\r'); break;
                    case '\\': result.append('\\'); break;
                    case '"': result.append('"'); break;
                    case '\'': result.append('\''); break;
                    default: result.append('\\').append(c); break;
                }
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else {
                result.append(c);
            }
        }

        if (escaped) {
            result.append('\\');
        }

        return result.toString();
    }

    /**
     * Generate TOML string from map
     */
    private String generateToml(Map<String, Object> config) {
        StringBuilder sb = new StringBuilder();

        // First, write top-level key=value pairs
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (!(entry.getValue() instanceof Map)) {
                sb.append(entry.getKey()).append(" = ").append(toTomlValue(entry.getValue())).append("\n");
            }
        }

        // Then write sections
        for (Map.Entry<String, Object> entry : config.entrySet()) {
            if (entry.getValue() instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> section = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, entry.getKey(), section);
            }
        }

        return sb.toString();
    }

    /**
     * Write a TOML section recursively
     */
    private void writeTomlSection(StringBuilder sb, String sectionPath, Map<String, Object> section) {
        // Check if this section contains nested sections
        boolean hasNestedSections = section.values().stream().anyMatch(v -> v instanceof Map);
        boolean hasSimpleValues = section.values().stream().anyMatch(v -> !(v instanceof Map));

        // Write section header and simple values
        if (hasSimpleValues) {
            sb.append("[").append(sectionPath).append("]\n");
            for (Map.Entry<String, Object> entry : section.entrySet()) {
                if (!(entry.getValue() instanceof Map)) {
                    sb.append(entry.getKey()).append(" = ").append(toTomlValue(entry.getValue())).append("\n");
                }
            }
        }

        // Write nested sections
        for (Map.Entry<String, Object> entry : section.entrySet()) {
            if (entry.getValue() instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedSection = (Map<String, Object>) entry.getValue();
                writeTomlSection(sb, sectionPath + "." + entry.getKey(), nestedSection);
            }
        }
    }

    /**
     * Convert Java object to TOML value string
     */
    private String toTomlValue(Object value) {
        if (value == null) {
            return "\"\"";
        }
        if (value instanceof Boolean) {
            return value.toString();
        }
        if (value instanceof Number) {
            return value.toString();
        }
        // List -> TOML array
        if (value instanceof List) {
            @SuppressWarnings("unchecked")
            List<Object> list = (List<Object>) value;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(toTomlValue(list.get(i)));
            }
            sb.append("]");
            return sb.toString();
        }
        // Map -> TOML inline table
        if (value instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) value;
            StringBuilder sb = new StringBuilder("{ ");
            boolean first = true;
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                if (!first) sb.append(", ");
                first = false;
                sb.append("\"").append(escapeTomlString(entry.getKey())).append("\" = ");
                sb.append(toTomlValue(entry.getValue()));
            }
            sb.append(" }");
            return sb.toString();
        }
        // String: quote it
        String str = value.toString();
        return "\"" + escapeTomlString(str) + "\"";
    }

    /**
     * Escape special characters in TOML string
     */
    private String escapeTomlString(String str) {
        return str.replace("\\", "\\\\")
                  .replace("\"", "\\\"")
                  .replace("\n", "\\n")
                  .replace("\t", "\\t")
                  .replace("\r", "\\r");
    }

    /**
     * Convert JsonElement to Java object
     */
    private Object jsonElementToObject(com.google.gson.JsonElement element) {
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (element.isJsonPrimitive()) {
            com.google.gson.JsonPrimitive prim = element.getAsJsonPrimitive();
            if (prim.isBoolean()) {
                return prim.getAsBoolean();
            }
            if (prim.isNumber()) {
                Number num = prim.getAsNumber();
                if (num.doubleValue() == num.longValue()) {
                    return num.longValue();
                }
                return num.doubleValue();
            }
            return prim.getAsString();
        }
        if (element.isJsonObject()) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<String, com.google.gson.JsonElement> entry : element.getAsJsonObject().entrySet()) {
                map.put(entry.getKey(), jsonElementToObject(entry.getValue()));
            }
            return map;
        }
        return element.toString();
    }

    /**
     * Convert Map to JsonObject
     */
    private JsonObject mapToJsonObject(Map<String, Object> map) {
        JsonObject result = new JsonObject();
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            Object value = entry.getValue();
            if (value == null) {
                result.add(entry.getKey(), com.google.gson.JsonNull.INSTANCE);
            } else if (value instanceof Boolean) {
                result.addProperty(entry.getKey(), (Boolean) value);
            } else if (value instanceof Number) {
                result.addProperty(entry.getKey(), (Number) value);
            } else if (value instanceof String) {
                result.addProperty(entry.getKey(), (String) value);
            } else if (value instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> list = (List<Object>) value;
                result.add(entry.getKey(), listToJsonArray(list));
            } else if (value instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) value;
                result.add(entry.getKey(), mapToJsonObject(nestedMap));
            } else {
                result.addProperty(entry.getKey(), value.toString());
            }
        }
        return result;
    }

    /**
     * Convert List to JsonArray
     */
    private JsonArray listToJsonArray(List<Object> list) {
        JsonArray result = new JsonArray();
        for (Object item : list) {
            if (item == null) {
                result.add(com.google.gson.JsonNull.INSTANCE);
            } else if (item instanceof Boolean) {
                result.add((Boolean) item);
            } else if (item instanceof Number) {
                result.add((Number) item);
            } else if (item instanceof String) {
                result.add((String) item);
            } else if (item instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> nestedList = (List<Object>) item;
                result.add(listToJsonArray(nestedList));
            } else if (item instanceof Map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> nestedMap = (Map<String, Object>) item;
                result.add(mapToJsonObject(nestedMap));
            } else {
                result.add(item.toString());
            }
        }
        return result;
    }
}
