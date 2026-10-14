package com.github.claudecodegui.hooks;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Discovers Codex, Claude Code and Codemoss hooks and reports their supported operations.
 *
 * <p>Unknown schemas, malformed configuration and unsupported locations are surfaced as
 * validation issues so the UI cannot imply that an item is safe to edit or toggle.</p>
 */
public final class HookCatalogService {

    private static final Logger LOG = Logger.getInstance(HookCatalogService.class);
    private static final Gson GSON = new Gson();
    private static final int MAX_FILES = 500;
    private static final int MAX_DEPTH = 4;
    private static final long MAX_PREVIEW_BYTES = 128L * 1024L;
    private static final String CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED = "CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED";
    private static final String SCRIPT_TOGGLE_UNCONFIRMED = "SCRIPT_TOGGLE_SEMANTICS_UNCONFIRMED";
    private static final String CODEX_CONFIG_HOOKS_SUPPORTED = "CODEX_CONFIG_HOOKS_SUPPORTED";
    private static final Set<String> IGNORED_DIRECTORIES = Set.of(
            "__pycache__", ".git", "node_modules", ".ccgui-disabled-hooks");
    private static final Set<String> IGNORED_EXTENSIONS = Set.of(
            ".pyc", ".class", ".o", ".obj", ".dll", ".so", ".dylib", ".exe", ".bin",
            ".bak", ".tmp", ".swp");
    private static final Pattern SECRET_ASSIGNMENT = Pattern.compile(
            "(?i)(\\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential)"
                    + "[\\w-]*\\s*(?::|=|\\\\u003d)\\s*)[^\\r\\n,;]+"
    );
    private static final Pattern BEARER_TOKEN = Pattern.compile("(?i)(\\bBearer\\s+)[A-Za-z0-9._~+/=-]+");
    private static final Pattern SENSITIVE_FIELD_NAME = Pattern.compile(
            "(?i).*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential).*"
    );

    private final Path userHome;

    public HookCatalogService() {
        this(Paths.get(NodeDetector.resolveHomeForFileOps()));
    }

    public HookCatalogService(Path userHome) {
        this.userHome = userHome.toAbsolutePath().normalize();
    }

    /** Scan supported locations for the supplied project root. */
    public JsonObject scan(String projectRoot) {
        Path project = normalizeProjectRoot(projectRoot);
        JsonArray items = new JsonArray();
        JsonArray sources = new JsonArray();
        JsonArray capabilities = capabilityMatrix();

        scanClaudeSettings(userHome.resolve(".claude").resolve("settings.json"), "GLOBAL", items, sources);
        scanClaudeSettings(userHome.resolve(".claude").resolve("settings.local.json"), "GLOBAL_LOCAL", items, sources);
        if (project != null) {
            Path claudeDir = project.resolve(".claude");
            scanClaudeSettings(claudeDir.resolve("settings.json"), "PROJECT", items, sources);
            scanClaudeSettings(claudeDir.resolve("settings.local.json"), "PROJECT_LOCAL", items, sources);
        }

        scanDirectory("codex", "GLOBAL", userHome.resolve(".codex").resolve("hooks"), items, sources);
        scanDirectory("codemoss", "GLOBAL", userHome.resolve(".codemoss").resolve("hooks"), items, sources);
        if (project != null) {
            scanDirectory("codex", "PROJECT", project.resolve(".codex").resolve("hooks"), items, sources);
            scanDirectory("codemoss", "PROJECT", project.resolve(".codemoss").resolve("hooks"), items, sources);
        }

        scanCodexConfig(userHome.resolve(".codex").resolve("config.toml"), "GLOBAL", items, sources);
        if (project != null) {
            scanCodexConfig(project.resolve(".codex").resolve("config.toml"), "PROJECT", items, sources);
        }

        JsonObject result = new JsonObject();
        result.addProperty("schemaVersion", 1);
        result.add("items", items);
        result.add("sources", sources);
        result.add("capabilities", capabilities);
        result.addProperty("readOnly", false);
        return result;
    }

    private void scanClaudeSettings(Path settingsPath, String scope, JsonArray items, JsonArray sources) {
        JsonObject source = source("claude", scope, settingsPath, "settings-json");
        sources.add(source);
        if (!Files.isRegularFile(settingsPath)) {
            return;
        }

        try {
            JsonElement root = JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8));
            if (!root.isJsonObject()) {
                addSourceIssue(source, "SETTINGS_NOT_OBJECT");
                return;
            }
            collectDisabledClaudeHooks(settingsPath, scope, items, source);
            JsonElement hooks = root.getAsJsonObject().get("hooks");
            if (hooks == null || hooks.isJsonNull()) {
                return;
            }
            if (!hooks.isJsonObject()) {
                addSourceIssue(source, "HOOKS_NOT_OBJECT");
                return;
            }
            for (String event : hooks.getAsJsonObject().keySet()) {
                JsonElement eventValue = hooks.getAsJsonObject().get(event);
                collectClaudeHookValue(eventValue, event, settingsPath, scope, items, source, 0, event);
            }
        } catch (Exception e) {
            addSourceIssue(source, "INVALID_JSON");
            LOG.debug("[HookCatalog] Failed to parse Claude settings: " + settingsPath, e);
        }
    }

    private void collectClaudeHookValue(
            JsonElement value,
            String event,
            Path settingsPath,
            String scope,
            JsonArray items,
            JsonObject source,
            int depth,
            String managedKey
    ) {
        if (depth > MAX_DEPTH || value == null || value.isJsonNull()) {
            return;
        }
        if (value.isJsonArray()) {
            for (int i = 0; i < value.getAsJsonArray().size(); i++) {
                collectClaudeHookValue(value.getAsJsonArray().get(i), event, settingsPath, scope, items, source,
                        depth + 1, managedKey + "/" + i);
            }
            return;
        }
        if (!value.isJsonObject()) {
            addSourceIssue(source, "HOOK_ENTRY_NOT_OBJECT");
            return;
        }

        JsonObject object = value.getAsJsonObject();
        JsonElement nested = object.get("hooks");
        if (nested != null && !nested.isJsonNull()) {
            String matcher = primitiveString(object, "matcher");
            if (nested.isJsonArray()) {
                for (int i = 0; i < nested.getAsJsonArray().size(); i++) {
                    collectClaudeHookObject(nested.getAsJsonArray().get(i), event, matcher, settingsPath, scope,
                            items, source, depth + 1, managedKey + "/hooks/" + i);
                }
            } else {
                collectClaudeHookObject(nested, event, matcher, settingsPath, scope, items, source, depth + 1,
                        managedKey + "/hooks");
            }
            return;
        }
        collectClaudeHookObject(object, event, primitiveString(object, "matcher"),
                settingsPath, scope, items, source, depth, managedKey);
    }

    private void collectClaudeHookObject(
            JsonElement value,
            String event,
            String matcher,
            Path settingsPath,
            String scope,
            JsonArray items,
            JsonObject source,
            int depth,
            String managedKey
    ) {
        if (value == null || !value.isJsonObject() || depth > MAX_DEPTH) {
            addSourceIssue(source, "HOOK_ENTRY_NOT_OBJECT");
            return;
        }
        JsonObject object = value.getAsJsonObject();
        String command = primitiveString(object, "command");
        JsonArray issues = new JsonArray();
        if (command == null || command.isBlank()) {
            issues.add("COMMAND_MISSING");
        }
        if (!object.has("type")) {
            issues.add("TYPE_MISSING");
        }
        JsonObject item = baseItem("claude", scope, event, settingsPath, command, matcher);
        item.addProperty("sourceId", item.get("sourceId").getAsString() + "-" + shortHash(managedKey));
        item.addProperty("managedKey", managedKey);
        // Claude Code has no per-hook enabled field; CCGUI manages individual state separately.
        item.addProperty("enabled", true);
        item.addProperty("toggleSupported", false);
        item.addProperty("managedToggleSupported", true);
        item.addProperty("toggleMode", "ccgui-managed");
        item.addProperty("toggleReason", CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED);
        item.addProperty("format", "claude-settings-json");
        item.add("validationIssues", issues);
        item.add("extensions", unknownFields(object, Set.of("type", "command", "matcher", "hooks")));
        item.addProperty("rawPreview", sanitizePreview(GSON.toJson(object)));
        items.add(item);
    }

    private void scanDirectory(
            String provider,
            String scope,
            Path directory,
            JsonArray items,
            JsonArray sources
    ) {
        JsonObject source = source(provider, scope, directory, "hook-directory");
        sources.add(source);
        collectDisabledScripts(provider, scope, directory, items, source);
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> stream = Files.walk(directory, MAX_DEPTH)) {
            List<Path> files = stream.filter(Files::isRegularFile)
                    .filter(file -> !Files.isSymbolicLink(file))
                    .filter(file -> isHookScriptCandidate(directory, file))
                    .sorted(Comparator.comparing(Path::toString))
                    .limit(MAX_FILES)
                    .toList();
            if (files.size() >= MAX_FILES) {
                addSourceIssue(source, "FILE_LIMIT_REACHED");
            }
            for (Path file : files) {
                items.add(scriptItem(provider, scope, directory, file));
            }
        } catch (IOException e) {
            addSourceIssue(source, "SCAN_FAILED");
            LOG.debug("[HookCatalog] Failed to scan hook directory: " + directory, e);
        }
    }

    private JsonObject scriptItem(String provider, String scope, Path root, Path file) {
        String relative = root.relativize(file).toString();
        String event = relative;
        String command = file.toAbsolutePath().normalize().toString();
        JsonObject item = baseItem(provider, scope, event, file, command, null);
        item.addProperty("enabled", true);
        item.addProperty("toggleSupported", false);
        item.addProperty("managedToggleSupported", true);
        item.addProperty("toggleMode", "ccgui-managed");
        item.addProperty("toggleReason", SCRIPT_TOGGLE_UNCONFIRMED);
        item.addProperty("format", "script-file");
        item.addProperty("relativePath", relative);
        JsonArray issues = new JsonArray();
        item.add("validationIssues", issues);
        try {
            long size = Files.size(file);
            if (size <= MAX_PREVIEW_BYTES) {
                item.addProperty("rawPreview", sanitizePreview(Files.readString(file, StandardCharsets.UTF_8)));
            } else {
                issues.add("PREVIEW_TRUNCATED");
            }
        } catch (Exception e) {
            issues.add("READ_FAILED");
        }
        return item;
    }

    private static boolean isHookScriptCandidate(Path root, Path file) {
        Path relative = root.relativize(file);
        for (Path part : relative) {
            if (IGNORED_DIRECTORIES.contains(part.toString())) {
                return false;
            }
        }
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.startsWith(".ccgui-") || name.endsWith("~")) {
            return false;
        }
        return IGNORED_EXTENSIONS.stream().noneMatch(name::endsWith);
    }

    private void collectDisabledClaudeHooks(
            Path settingsPath,
            String scope,
            JsonArray items,
            JsonObject source
    ) {
        JsonArray entries;
        try {
            entries = new HookToggleStateStore(settingsPath.getParent()).readStrict()
                    .getAsJsonArray("disabledClaude");
        } catch (IOException e) {
            addSourceIssue(source, "TOGGLE_STATE_INVALID");
            return;
        }
        String location = settingsPath.toAbsolutePath().normalize().toString();
        String revision = revision(settingsPath);
        for (JsonElement element : entries) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject entry = element.getAsJsonObject();
            if (!location.equals(stringValue(entry, "location"))) {
                continue;
            }
            JsonObject hook = entry.getAsJsonObject("hook");
            if (hook == null) {
                continue;
            }
            String command = primitiveString(hook, "command");
            JsonObject item = baseItem("claude", scope, stringValue(entry, "event"), settingsPath, command,
                    stringValue(entry, "matcher"));
            item.addProperty("sourceId", stringValue(entry, "sourceId"));
            if (entry.has("managedKey")) {
                item.addProperty("managedKey", stringValue(entry, "managedKey"));
            }
            item.addProperty("enabled", false);
            item.addProperty("toggleSupported", false);
            item.addProperty("managedToggleSupported", true);
            item.addProperty("toggleMode", "ccgui-managed");
            item.addProperty("toggleReason", "CCGUI_MANAGED_TOGGLE");
            item.addProperty("revision", revision);
            item.addProperty("format", "claude-settings-json");
            item.add("validationIssues", new JsonArray());
            item.add("extensions", unknownFields(hook, Set.of("type", "command", "matcher", "hooks")));
            item.addProperty("rawPreview", sanitizePreview(GSON.toJson(hook)));
            items.add(item);
        }
    }

    private void collectDisabledScripts(
            String provider,
            String scope,
            Path directory,
            JsonArray items,
            JsonObject source
    ) {
        JsonArray entries;
        try {
            entries = new HookToggleStateStore(directory.getParent()).readStrict()
                    .getAsJsonArray("disabledScripts");
        } catch (IOException e) {
            addSourceIssue(source, "TOGGLE_STATE_INVALID");
            return;
        }
        String normalizedDirectory = directory.toAbsolutePath().normalize().toString();
        for (JsonElement element : entries) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject entry = element.getAsJsonObject();
            if (!provider.equals(stringValue(entry, "provider"))
                    || !scope.equals(stringValue(entry, "scope"))) {
                continue;
            }
            Path original;
            try {
                original = Path.of(entry.get("originalLocation").getAsString()).toAbsolutePath().normalize();
            } catch (RuntimeException e) {
                continue;
            }
            if (!original.startsWith(directory.toAbsolutePath().normalize())
                    || original.toString().equals(normalizedDirectory)) {
                continue;
            }
            JsonObject item = baseItem(provider, scope, stringValue(entry, "event"), original,
                    original.toString(), null);
            item.addProperty("sourceId", stringValue(entry, "sourceId"));
            item.addProperty("enabled", false);
            item.addProperty("toggleSupported", false);
            item.addProperty("managedToggleSupported", true);
            item.addProperty("toggleMode", "ccgui-managed");
            item.addProperty("toggleReason", "CCGUI_MANAGED_TOGGLE");
            item.addProperty("editSupported", false);
            item.addProperty("format", "script-file");
            item.addProperty("relativePath", stringValue(entry, "relativePath"));
            item.addProperty("revision", "disabled:" + stringValue(entry, "revision"));
            item.add("validationIssues", new JsonArray());
            item.add("extensions", new JsonObject());
            items.add(item);
        }
    }

    private void scanCodexConfig(Path configPath, String scope, JsonArray items, JsonArray sources) {
        JsonObject source = source("codex", scope, configPath, "config-toml");
        sources.add(source);
        if (!Files.isRegularFile(configPath)) {
            return;
        }
        try {
            if (Files.size(configPath) > MAX_PREVIEW_BYTES) {
                addSourceIssue(source, "SOURCE_TOO_LARGE");
                return;
            }
            CodexHookToml.ParseResult parsed = CodexHookToml.parse(
                    Files.readString(configPath, StandardCharsets.UTF_8));
            for (String issue : parsed.sourceIssues()) {
                addSourceIssue(source, issue);
            }
            if (!parsed.valid()) {
                return;
            }
            if (!parsed.featureEnabled() && !parsed.entries().isEmpty()) {
                addSourceIssue(source, "CODEX_HOOKS_FEATURE_DISABLED");
            }
            for (CodexHookToml.Entry entry : parsed.entries()) {
                JsonObject item = baseItem("codex", scope, entry.event(), configPath,
                        entry.command(), entry.matcher());
                item.addProperty("sourceId", item.get("sourceId").getAsString()
                        + "-" + shortHash(entry.managedKey()));
                item.addProperty("managedKey", entry.managedKey());
                item.addProperty("enabled", Boolean.TRUE.equals(entry.enabled()));
                boolean toggleSupported = entry.enabled() != null && entry.validationIssues().isEmpty();
                item.addProperty("toggleSupported", toggleSupported);
                item.addProperty("managedToggleSupported", false);
                item.addProperty("toggleMode", "native");
                item.addProperty("toggleReason", toggleSupported
                        ? CODEX_CONFIG_HOOKS_SUPPORTED : "CODEX_CONFIG_HOOK_INVALID");
                item.addProperty("format", "config-toml");
                JsonArray issues = new JsonArray();
                entry.validationIssues().forEach(issues::add);
                item.add("validationIssues", issues);
                item.addProperty("rawPreview", sanitizePreview(entry.rawPreview()));
                items.add(item);
            }
        } catch (IOException | RuntimeException e) {
            addSourceIssue(source, "READ_FAILED");
            LOG.debug("[HookCatalog] Failed to parse Codex hooks: " + configPath, e);
        }
    }

    private static JsonArray capabilityMatrix() {
        JsonArray capabilities = new JsonArray();
        capabilities.add(capability("claude", "settings-json", true, false,
                true, CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED, "UNVERIFIED"));
        capabilities.add(capability("codex", "hook-directory", true, false,
                true, SCRIPT_TOGGLE_UNCONFIRMED, "UNVERIFIED"));
        capabilities.add(capability("codemoss", "hook-directory", true, false,
                true, SCRIPT_TOGGLE_UNCONFIRMED, "UNVERIFIED"));
        capabilities.add(capability("codex", "config-toml", true, true,
                false, CODEX_CONFIG_HOOKS_SUPPORTED, "VERIFIED"));
        return capabilities;
    }

    private static JsonObject capability(
            String provider,
            String format,
            boolean editSupported,
            boolean toggleSupported,
            boolean managedToggleSupported,
            String reasonCode,
            String versionStatus
    ) {
        JsonObject capability = new JsonObject();
        capability.addProperty("provider", provider);
        capability.addProperty("format", format);
        capability.addProperty("editSupported", editSupported);
        capability.addProperty("toggleSupported", toggleSupported);
        capability.addProperty("managedToggleSupported", managedToggleSupported);
        capability.addProperty("toggleMode", toggleSupported ? "native"
                : managedToggleSupported ? "ccgui-managed" : "none");
        capability.addProperty("reasonCode", reasonCode);
        capability.addProperty("versionStatus", versionStatus);
        return capability;
    }

    private JsonObject source(String provider, String scope, Path path, String format) {
        JsonObject source = new JsonObject();
        source.addProperty("provider", provider);
        source.addProperty("scope", scope);
        source.addProperty("location", path.toAbsolutePath().normalize().toString());
        source.addProperty("format", format);
        source.addProperty("exists", Files.exists(path));
        source.addProperty("readOnly", false);
        source.addProperty("revision", revision(path));
        addLastModified(source, path);
        source.add("validationIssues", new JsonArray());
        return source;
    }

    private JsonObject baseItem(String provider, String scope, String event, Path location,
                                String command, String matcher) {
        JsonObject item = new JsonObject();
        item.addProperty("sourceId", provider + "-" + scope.toLowerCase() + "-" + shortHash(
                location.toAbsolutePath().normalize() + "|" + event + "|" + (command == null ? "" : command)));
        item.addProperty("provider", provider);
        item.addProperty("scope", scope);
        item.addProperty("event", event);
        if (matcher != null && !matcher.isBlank()) {
            item.addProperty("matcher", matcher);
        }
        item.addProperty("command", command == null ? "" : sanitizePreview(command));
        item.addProperty("rawLocation", location.toAbsolutePath().normalize().toString());
        item.addProperty("schemaVersion", 1);
        item.addProperty("revision", revision(location));
        addLastModified(item, location);
        item.addProperty("editSupported", true);
        item.add("extensions", new JsonObject());
        return item;
    }

    private static JsonObject unknownFields(JsonObject object, Set<String> known) {
        JsonObject extensions = new JsonObject();
        for (String key : object.keySet()) {
            if (!known.contains(key)) {
                extensions.add(key, sanitizeExtensionValue(key, object.get(key)));
            }
        }
        return extensions;
    }

    private static JsonElement sanitizeExtensionValue(String field, JsonElement value) {
        if (SENSITIVE_FIELD_NAME.matcher(field).matches()) {
            return new JsonPrimitive("<redacted>");
        }
        if (value.isJsonObject()) {
            JsonObject sanitized = new JsonObject();
            for (String key : value.getAsJsonObject().keySet()) {
                sanitized.add(key, sanitizeExtensionValue(key, value.getAsJsonObject().get(key)));
            }
            return sanitized;
        }
        if (value.isJsonArray()) {
            JsonArray sanitized = new JsonArray();
            for (JsonElement element : value.getAsJsonArray()) {
                sanitized.add(sanitizeExtensionValue("", element));
            }
            return sanitized;
        }
        if (value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) {
            return new JsonPrimitive(sanitizePreview(value.getAsString()));
        }
        return value.deepCopy();
    }

    private static void addLastModified(JsonObject target, Path path) {
        try {
            if (Files.exists(path)) {
                target.addProperty("lastModified", Files.getLastModifiedTime(path).toMillis());
            }
        } catch (IOException e) {
            LOG.debug("[Hooks] Failed to read last modified time: " + path, e);
        }
    }

    private static String primitiveString(JsonObject object, String field) {
        JsonElement value = object.get(field);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    private static String stringValue(JsonObject object, String field) {
        JsonElement value = object.get(field);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    private static String sanitizePreview(String value) {
        if (value == null || value.isEmpty()) {
            return value;
        }
        String sanitized = SECRET_ASSIGNMENT.matcher(value).replaceAll("$1<redacted>");
        return BEARER_TOKEN.matcher(sanitized).replaceAll("$1<redacted>");
    }

    private static void addSourceIssue(JsonObject source, String issue) {
        source.getAsJsonArray("validationIssues").add(issue);
    }

    private static String revision(Path path) {
        try {
            if (Files.isRegularFile(path)) {
                return Files.size(path) + ":" + Files.getLastModifiedTime(path).toMillis();
            }
            if (Files.exists(path)) {
                return "directory:" + Files.getLastModifiedTime(path).toMillis();
            }
        } catch (IOException ignored) {
            // The path is still reported; a missing revision blocks future writes.
        }
        return "missing";
    }

    private static String shortHash(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(16);
            for (int i = 0; i < 8; i++) {
                result.append(String.format("%02x", digest[i]));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString(input.hashCode());
        }
    }

    private static Path normalizeProjectRoot(String projectRoot) {
        if (projectRoot == null || projectRoot.isBlank()) {
            return null;
        }
        try {
            return Paths.get(projectRoot).toAbsolutePath().normalize();
        } catch (Exception e) {
            return null;
        }
    }
}
