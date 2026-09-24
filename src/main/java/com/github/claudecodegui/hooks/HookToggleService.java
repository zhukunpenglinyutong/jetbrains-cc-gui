package com.github.claudecodegui.hooks;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;
import java.util.regex.Pattern;

/** Implements reversible CCGUI-managed toggles for Claude and directory-based hooks. */
public final class HookToggleService {

    private static final Logger LOG = Logger.getInstance(HookToggleService.class);
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Pattern CONTROL_CHARACTERS = Pattern.compile("[\\u0000-\\u001f]");
    private static final String MANAGED_TOGGLE = "ccgui-managed";
    private static final String NATIVE_TOGGLE = "native";

    private final Path userHome;
    private final HookMutationService mutationService;
    private final HookPathPolicy pathPolicy;

    public HookToggleService(Path userHome) {
        this.userHome = userHome.toAbsolutePath().normalize();
        this.mutationService = new HookMutationService(this.userHome);
        this.pathPolicy = new HookPathPolicy(this.userHome);
    }

    public JsonObject toggle(String projectRoot, JsonObject request) {
        try {
            String provider = requiredString(request, "provider");
            String location = requiredString(request, "location");
            String format = stringValue(request, "format");
            requiredString(request, "expectedRevision");
            if (!request.has("enabled") || !request.get("enabled").isJsonPrimitive()
                    || !request.get("enabled").getAsJsonPrimitive().isBoolean()) {
                return failure(request, "INVALID_REQUEST");
            }
            Path project = normalizeProject(projectRoot);
            Path lockDirectory;
            boolean codexConfig = "codex".equals(provider) && "config-toml".equals(format);
            if (codexConfig) {
                Path target = validateCodexTarget(project, location);
                if (target == null) {
                    return failure(request, "INVALID_HOOK_PATH");
                }
                lockDirectory = target.getParent();
            } else if ("claude".equals(provider)) {
                Path target = validateClaudeTarget(project, location);
                if (target == null) {
                    return failure(request, "INVALID_HOOK_PATH");
                }
                lockDirectory = target.getParent();
            } else if ("codex".equals(provider) || "codemoss".equals(provider)) {
                ScriptLocation script = resolveScriptLocation(project, location, provider);
                if (script == null) {
                    return failure(request, "INVALID_HOOK_PATH");
                }
                lockDirectory = script.providerDirectory;
            } else {
                return failure(request, "UNSUPPORTED_HOOK_PROVIDER");
            }
            return withLock(lockDirectory, request, () -> {
                String expectedRevision = requiredString(request, "expectedRevision");
                boolean enabled = request.get("enabled").getAsBoolean();
                if (codexConfig) {
                    return toggleCodexConfig(projectRoot, request, location, expectedRevision, enabled);
                }
                if ("claude".equals(provider)) {
                    return toggleClaude(projectRoot, request, location, expectedRevision, enabled);
                }
                return toggleScript(projectRoot, request, location, expectedRevision, enabled, provider);
            });
        } catch (RuntimeException e) {
            LOG.debug("[HookToggle] Invalid toggle request", e);
            return failure(request, "INVALID_REQUEST");
        }
    }

    private JsonObject toggleCodexConfig(
            String projectRoot,
            JsonObject request,
            String location,
            String expectedRevision,
            boolean enabled
    ) {
        Path project = normalizeProject(projectRoot);
        Path target = validateCodexTarget(project, location);
        if (target == null) {
            return failure(request, "INVALID_HOOK_PATH");
        }
        try {
            if (!revision(target).equals(expectedRevision)) {
                return failure(request, "HOOK_REVISION_CONFLICT");
            }
            String original = Files.readString(target, StandardCharsets.UTF_8);
            CodexHookToml.UpdateResult update = CodexHookToml.updateEnabled(
                    original, requiredString(request, "managedKey"), enabled);
            if (!update.success()) {
                return failure(request, update.errorCode());
            }
            JsonObject mutation = mutationService.write(
                    projectRoot, target.toString(), expectedRevision, update.content());
            if (!mutation.get("success").getAsBoolean()) {
                return mutation;
            }
            mutation.addProperty("sourceId", requiredString(request, "sourceId"));
            attachRequestId(mutation, request);
            mutation.addProperty("enabled", enabled);
            mutation.addProperty("toggleMode", NATIVE_TOGGLE);
            return mutation;
        } catch (IOException | RuntimeException e) {
            LOG.warn("[HookToggle] Failed to toggle Codex hook: " + target, e);
            return failure(request, "HOOK_TOGGLE_FAILED");
        }
    }

    private JsonObject toggleClaude(
            String projectRoot,
            JsonObject request,
            String location,
            String expectedRevision,
            boolean enabled
    ) {
        Path project = normalizeProject(projectRoot);
        Path target = validateClaudeTarget(project, location);
        if (target == null) {
            return failure("INVALID_HOOK_PATH");
        }
        String sourceId = requiredString(request, "sourceId");
        String scope = requiredString(request, "scope");
        try {
            String original = Files.readString(target, StandardCharsets.UTF_8);
            if (!revision(target).equals(expectedRevision)) {
                return failure("HOOK_REVISION_CONFLICT");
            }
            JsonObject root = JsonParser.parseString(original).getAsJsonObject();
            if (root.has("hooks") && !root.get("hooks").isJsonNull() && !root.get("hooks").isJsonObject()) {
                return failure(request, "HOOKS_NOT_OBJECT");
            }
            HookToggleStateStore store = new HookToggleStateStore(target.getParent());
            JsonObject state = store.readStrict();
            JsonArray disabled = state.getAsJsonArray("disabledClaude");
            JsonObject mutation;
            if (enabled) {
                JsonObject entry = findDisabledClaude(disabled, target, sourceId);
                if (entry == null) {
                    return failure(request, "HOOK_NOT_DISABLED");
                }
                restoreClaudeHook(root, entry);
                mutation = mutationService.write(projectRoot, target.toString(), expectedRevision,
                        GSON.toJson(root));
                if (!mutation.get("success").getAsBoolean()) {
                    return mutation;
                }
                disabled.remove(entry);
                try {
                    store.write(state);
                } catch (IOException e) {
                    rollback(projectRoot, target, mutation, original);
                    return failure(request, "HOOK_STATE_WRITE_FAILED");
                }
            } else {
                if (findDisabledClaude(disabled, target, sourceId) != null) {
                    return failure(request, "HOOK_ALREADY_DISABLED");
                }
                HookMatch match = findClaudeHook(root, sourceId, scope, target, request);
                if (match == null) {
                    return failure(request, "HOOK_NOT_FOUND");
                }
                JsonObject entry = new JsonObject();
                entry.addProperty("sourceId", "claude-disabled-" + UUID.randomUUID());
                entry.addProperty("originalSourceId", sourceId);
                if (request.has("managedKey")) {
                    entry.addProperty("managedKey", request.get("managedKey").getAsString());
                }
                entry.addProperty("location", target.toString());
                entry.addProperty("event", match.event);
                if (match.matcher != null) {
                    entry.addProperty("matcher", match.matcher);
                }
                entry.addProperty("wrapped", match.wrapped);
                entry.addProperty("index", match.index);
                entry.addProperty("parentIndex", match.parentIndex);
                entry.add("hook", match.hook.deepCopy());
                removeClaudeHook(match);
                mutation = mutationService.write(projectRoot, target.toString(), expectedRevision,
                        GSON.toJson(root));
                if (!mutation.get("success").getAsBoolean()) {
                    return mutation;
                }
                disabled.add(entry);
                try {
                    store.write(state);
                } catch (IOException e) {
                    rollback(projectRoot, target, mutation, original);
                    return failure(request, "HOOK_STATE_WRITE_FAILED");
                }
            }
            JsonObject result = success();
            result.addProperty("location", target.toString());
            result.addProperty("sourceId", sourceId);
            attachRequestId(result, request);
            result.addProperty("enabled", enabled);
            result.addProperty("toggleMode", MANAGED_TOGGLE);
            result.addProperty("revision", revision(target));
            result.addProperty("lastModified", Files.getLastModifiedTime(target).toMillis());
            return result;
        } catch (IOException | RuntimeException e) {
            LOG.warn("[HookToggle] Failed to toggle Claude hook: " + target, e);
            return failure(request, "HOOK_TOGGLE_FAILED");
        }
    }

    private JsonObject toggleScript(
            String projectRoot,
            JsonObject request,
            String location,
            String expectedRevision,
            boolean enabled,
            String provider
    ) {
        Path project = normalizeProject(projectRoot);
        ScriptLocation script = resolveScriptLocation(project, location, provider);
        if (script == null) {
            return failure("INVALID_HOOK_PATH");
        }
        String sourceId = requiredString(request, "sourceId");
        Path movedFrom = null;
        Path movedTo = null;
        try {
            HookToggleStateStore store = new HookToggleStateStore(script.providerDirectory);
            JsonObject state = store.readStrict();
            JsonArray disabled = state.getAsJsonArray("disabledScripts");
            JsonObject entry = findDisabledScript(disabled, script.original.toString(), sourceId);
            if (enabled) {
                if (entry == null) {
                    return failure(request, "HOOK_NOT_DISABLED");
                }
                Path quarantine = Paths.get(entry.get("quarantineLocation").getAsString()).toAbsolutePath().normalize();
                Path quarantineRoot = script.providerDirectory.resolve(".ccgui-disabled-hooks").normalize();
                if (!quarantine.startsWith(quarantineRoot) || Files.isSymbolicLink(quarantine)
                        || !Files.isRegularFile(quarantine) || Files.exists(script.original)) {
                    return failure(request, "HOOK_RESTORE_CONFLICT");
                }
                if (!("disabled:" + entry.get("revision").getAsString()).equals(expectedRevision)) {
                    return failure(request, "HOOK_REVISION_CONFLICT");
                }
                if (!entry.get("revision").getAsString().equals(revision(quarantine))) {
                    return failure(request, "HOOK_QUARANTINE_MODIFIED");
                }
                Files.createDirectories(script.original.getParent());
                movedFrom = quarantine;
                movedTo = script.original;
                moveAtomically(quarantine, script.original);
                disabled.remove(entry);
            } else {
                if (entry != null) {
                    return failure(request, "HOOK_ALREADY_DISABLED");
                }
                if (!Files.isRegularFile(script.original) || Files.isSymbolicLink(script.original)) {
                    return failure(request, "HOOK_NOT_FOUND");
                }
                if (!pathPolicy.isUnderHookRoot(script.original, script.hookDirectory)) {
                    return failure(request, "INVALID_HOOK_PATH");
                }
                if (!revision(script.original).equals(expectedRevision)) {
                    return failure(request, "HOOK_REVISION_CONFLICT");
                }
                String id = UUID.randomUUID().toString();
                Path quarantine = script.providerDirectory.resolve(".ccgui-disabled-hooks")
                        .resolve(id).resolve(script.relativePath).normalize();
                if (!quarantine.startsWith(script.providerDirectory.resolve(".ccgui-disabled-hooks").normalize())) {
                    return failure(request, "INVALID_HOOK_PATH");
                }
                Files.createDirectories(quarantine.getParent());
                movedFrom = script.original;
                movedTo = quarantine;
                moveAtomically(script.original, quarantine);
                entry = new JsonObject();
                entry.addProperty("sourceId", sourceId);
                entry.addProperty("provider", provider);
                entry.addProperty("scope", request.get("scope").getAsString());
                entry.addProperty("originalLocation", script.original.toString());
                entry.addProperty("quarantineLocation", quarantine.toString());
                entry.addProperty("relativePath", script.relativePath);
                entry.addProperty("revision", expectedRevision);
                entry.addProperty("event", request.has("event") ? request.get("event").getAsString() : "");
                disabled.add(entry);
            }
            store.write(state);
            movedFrom = null;
            movedTo = null;
            JsonObject result = success();
            result.addProperty("location", script.original.toString());
            result.addProperty("sourceId", sourceId);
            attachRequestId(result, request);
            result.addProperty("enabled", enabled);
            result.addProperty("toggleMode", MANAGED_TOGGLE);
            result.addProperty("revision", enabled ? revision(script.original) : disabledRevision(entry));
            return result;
        } catch (IOException | RuntimeException e) {
            if (movedFrom != null && movedTo != null) {
                try {
                    if (Files.exists(movedTo) && !Files.exists(movedFrom)) {
                        moveAtomically(movedTo, movedFrom);
                    }
                } catch (IOException rollbackError) {
                    LOG.warn("[HookToggle] Failed to roll back script move: " + location, rollbackError);
                }
            }
            LOG.warn("[HookToggle] Failed to toggle script hook: " + location, e);
            return failure(request, "HOOK_TOGGLE_FAILED");
        }
    }

    private static HookMatch findClaudeHook(
            JsonObject root,
            String sourceId,
            String scope,
            Path location,
            JsonObject request
    ) {
        JsonElement hooksElement = root.get("hooks");
        if (hooksElement == null || !hooksElement.isJsonObject()) {
            return null;
        }
        for (String event : hooksElement.getAsJsonObject().keySet()) {
            JsonElement eventValue = hooksElement.getAsJsonObject().get(event);
            if (!eventValue.isJsonArray()) {
                continue;
            }
            JsonArray eventArray = eventValue.getAsJsonArray();
            for (int i = 0; i < eventArray.size(); i++) {
                JsonElement element = eventArray.get(i);
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject object = element.getAsJsonObject();
                JsonElement nested = object.get("hooks");
                if (nested != null && nested.isJsonArray()) {
                    JsonArray nestedArray = nested.getAsJsonArray();
                    String matcher = stringValue(object, "matcher");
                    for (int j = 0; j < nestedArray.size(); j++) {
                        JsonElement child = nestedArray.get(j);
                        if (child.isJsonObject() && matchesSourceId(
                                sourceId, scope, location, event, child.getAsJsonObject(), request,
                                event + "/" + i + "/hooks/" + j)) {
                            return new HookMatch(event, matcher, child.getAsJsonObject(), nestedArray, j, i, true);
                        }
                    }
                } else if (matchesSourceId(sourceId, scope, location, event, object, request,
                        event + "/" + i)) {
                    return new HookMatch(event, stringValue(object, "matcher"), object, eventArray, i, -1, false);
                }
            }
        }
        return null;
    }

    private static boolean matchesSourceId(
            String sourceId,
            String scope,
            Path location,
            String event,
            JsonObject hook,
            JsonObject request,
            String managedKey
    ) {
        if (request.has("managedKey") && request.get("managedKey").isJsonPrimitive()) {
            return managedKey.equals(request.get("managedKey").getAsString());
        }
        String command = stringValue(hook, "command");
        String expected = sourceId("claude", scope, location, event, command);
        return (expected + "-" + shortHash(managedKey)).equals(sourceId);
    }

    private static void removeClaudeHook(HookMatch match) {
        match.parent.remove(match.index);
    }

    private static void restoreClaudeHook(JsonObject root, JsonObject entry) {
        JsonObject hook = entry.getAsJsonObject("hook").deepCopy();
        String event = entry.get("event").getAsString();
        String matcher = entry.has("matcher") ? entry.get("matcher").getAsString() : null;
        int index = entry.get("index").getAsInt();
        JsonObject hooks = root.has("hooks") && root.get("hooks").isJsonObject()
                ? root.getAsJsonObject("hooks") : new JsonObject();
        if (!root.has("hooks")) {
            root.add("hooks", hooks);
        }
        JsonArray eventArray = hooks.has(event) && hooks.get(event).isJsonArray()
                ? hooks.getAsJsonArray(event) : new JsonArray();
        if (!hooks.has(event)) {
            hooks.add(event, eventArray);
        }
        if (entry.has("wrapped") && entry.get("wrapped").getAsBoolean() && matcher != null) {
            int parentIndex = entry.has("parentIndex") ? entry.get("parentIndex").getAsInt() : -1;
            if (parentIndex >= 0 && parentIndex < eventArray.size()) {
                JsonElement parent = eventArray.get(parentIndex);
                if (parent.isJsonObject() && matcher.equals(stringValue(parent.getAsJsonObject(), "matcher"))
                        && parent.getAsJsonObject().has("hooks")
                        && parent.getAsJsonObject().get("hooks").isJsonArray()) {
                    insert(parent.getAsJsonObject().getAsJsonArray("hooks"), index, hook);
                    return;
                }
            }
            for (JsonElement element : eventArray) {
                if (element.isJsonObject() && matcher.equals(stringValue(element.getAsJsonObject(), "matcher"))
                        && element.getAsJsonObject().has("hooks")
                        && element.getAsJsonObject().get("hooks").isJsonArray()) {
                    JsonArray nested = element.getAsJsonObject().getAsJsonArray("hooks");
                    insert(nested, index, hook);
                    return;
                }
            }
            JsonObject wrapper = new JsonObject();
            wrapper.addProperty("matcher", matcher);
            JsonArray nested = new JsonArray();
            nested.add(hook);
            wrapper.add("hooks", nested);
            insert(eventArray, index, wrapper);
            return;
        }
        insert(eventArray, index, hook);
    }

    private static void insert(JsonArray array, int index, JsonElement value) {
        int insertionPoint = Math.max(0, Math.min(index, array.size()));
        JsonArray copy = new JsonArray();
        for (int i = 0; i < array.size(); i++) {
            if (i == insertionPoint) {
                copy.add(value);
            }
            copy.add(array.get(i));
        }
        if (insertionPoint == array.size()) {
            copy.add(value);
        }
        while (array.size() > 0) {
            array.remove(0);
        }
        for (JsonElement element : copy) {
            array.add(element);
        }
    }

    private ScriptLocation resolveScriptLocation(Path project, String location, String provider) {
        Path target;
        try {
            target = Paths.get(location).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
        Path globalDirectory = userHome.resolve("." + provider).resolve("hooks").toAbsolutePath().normalize();
        if (target.startsWith(globalDirectory) && !target.equals(globalDirectory)) {
            return new ScriptLocation(target, globalDirectory.getParent(), globalDirectory,
                    globalDirectory.relativize(target).toString());
        }
        if (project != null) {
            Path projectDirectory = project.resolve("." + provider).resolve("hooks").toAbsolutePath().normalize();
            if (target.startsWith(projectDirectory) && !target.equals(projectDirectory)) {
                return new ScriptLocation(target, projectDirectory.getParent(), projectDirectory,
                        projectDirectory.relativize(target).toString());
            }
        }
        return null;
    }

    private Path validateClaudeTarget(Path project, String location) {
        try {
            Path target = Paths.get(location).toAbsolutePath().normalize();
            if (CONTROL_CHARACTERS.matcher(location).find()) {
                return null;
            }
            if (pathPolicy.isClaudeSettings(target, project)
                    && Files.isRegularFile(target) && !Files.isSymbolicLink(target)) {
                return target;
            }
        } catch (RuntimeException ignored) {
            // Invalid paths are rejected by the caller.
        }
        return null;
    }

    private Path validateCodexTarget(Path project, String location) {
        try {
            Path target = pathPolicy.validateExistingTarget(project, location);
            return target != null && pathPolicy.isCodexConfig(target, project) ? target : null;
        } catch (IOException | RuntimeException ignored) {
            return null;
        }
    }

    private static JsonObject findDisabledClaude(JsonArray entries, Path location, String sourceId) {
        for (JsonElement element : entries) {
            JsonObject entry = element.getAsJsonObject();
            if (sourceId.equals(entry.get("sourceId").getAsString())
                    && location.toString().equals(entry.get("location").getAsString())) {
                return entry;
            }
        }
        return null;
    }

    private static JsonObject findDisabledScript(JsonArray entries, String location, String sourceId) {
        for (JsonElement element : entries) {
            JsonObject entry = element.getAsJsonObject();
            if (sourceId.equals(entry.get("sourceId").getAsString())
                    && location.equals(entry.get("originalLocation").getAsString())) {
                return entry;
            }
        }
        return null;
    }

    private void rollback(String projectRoot, Path target, JsonObject mutation, String original) {
        if (!mutation.has("revision")) {
            return;
        }
        try {
            mutationService.write(projectRoot, target.toString(),
                    mutation.get("revision").getAsString(), original);
        } catch (RuntimeException ignored) {
            // The backup remains available when automatic rollback cannot complete.
        }
    }

    private static void moveAtomically(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException e) {
            Files.move(source, target);
        }
    }

    private static JsonObject withLock(
            Path directory,
            JsonObject request,
            ToggleOperation operation
    ) {
        try {
            Files.createDirectories(directory);
            Path lockPath = directory.resolve(".ccgui-hooks-toggle.lock");
            if (Files.isSymbolicLink(lockPath)) {
                return failure(request, "HOOK_TOGGLE_LOCK_FAILED");
            }
            try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                FileLock lock;
                try {
                    lock = channel.tryLock();
                } catch (OverlappingFileLockException e) {
                    return failure(request, "HOOK_TOGGLE_LOCKED");
                }
                if (lock == null) {
                    return failure(request, "HOOK_TOGGLE_LOCKED");
                }
                try (FileLock ignored = lock) {
                    return operation.apply();
                }
            }
        } catch (IOException e) {
            return failure(request, "HOOK_TOGGLE_LOCK_FAILED");
        }
    }

    private static String disabledRevision(JsonObject entry) {
        return "disabled:" + entry.get("revision").getAsString();
    }

    private static String requiredString(JsonObject object, String key) {
        if (object == null || !object.has(key) || !object.get(key).isJsonPrimitive()) {
            throw new IllegalArgumentException(key);
        }
        return object.get(key).getAsString();
    }

    private static String stringValue(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    private static String sourceId(String provider, String scope, Path location, String event, String command) {
        return provider + "-" + scope.toLowerCase() + "-" + shortHash(
                location.toAbsolutePath().normalize() + "|" + event + "|" + (command == null ? "" : command));
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

    private static Path normalizeProject(String projectRoot) {
        if (projectRoot == null || projectRoot.isBlank()) {
            return null;
        }
        try {
            return Paths.get(projectRoot).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String revision(Path path) throws IOException {
        return Files.size(path) + ":" + Files.getLastModifiedTime(path).toMillis();
    }

    private static JsonObject success() {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        return result;
    }

    private static JsonObject failure(String code) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("errorCode", code);
        return result;
    }

    private static JsonObject failure(JsonObject request, String code) {
        JsonObject result = failure(code);
        if (request != null) {
            if (request.has("sourceId") && request.get("sourceId").isJsonPrimitive()) {
                result.addProperty("sourceId", request.get("sourceId").getAsString());
            }
            attachRequestId(result, request);
        }
        return result;
    }

    private static void attachRequestId(JsonObject result, JsonObject request) {
        if (request.has("requestId") && request.get("requestId").isJsonPrimitive()) {
            result.addProperty("requestId", request.get("requestId").getAsString());
        }
    }

    @FunctionalInterface
    private interface ToggleOperation {
        JsonObject apply();
    }

    private record HookMatch(
            String event,
            String matcher,
            JsonObject hook,
            JsonArray parent,
            int index,
            int parentIndex,
            boolean wrapped
    ) {
    }

    private record ScriptLocation(Path original, Path providerDirectory, Path hookDirectory, String relativePath) {
    }
}
