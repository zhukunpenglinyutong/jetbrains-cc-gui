package com.github.claudecodegui.hooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;

/** Implements guarded Claude managed toggles and native Codex hook preferences. */
public final class HookToggleService {

    private static final Logger LOG = Logger.getInstance(HookToggleService.class);
    private static final Pattern CONTROL_CHARACTERS = Pattern.compile("[\\u0000-\\u001f]");
    private static final String MANAGED_TOGGLE = "ccgui-managed";
    private static final String NATIVE_TOGGLE = "native";

    private final Path userHome;
    private final Path codexHome;
    private final HookMutationService mutationService;
    private final HookPathPolicy pathPolicy;

    public HookToggleService(Path userHome) {
        this(userHome, userHome.resolve(".codex"));
    }

    public HookToggleService(Path userHome, Path codexHome) {
        this.userHome = userHome.toAbsolutePath().normalize();
        this.codexHome = codexHome.toAbsolutePath().normalize();
        this.mutationService = new HookMutationService(this.userHome, this.codexHome);
        this.pathPolicy = new HookPathPolicy(this.userHome, this.codexHome);
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
            boolean codexConfig = "codex".equals(provider) && ("config-toml".equals(format) || "hooks-json".equals(format));
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
            } else {
                return failure(request, "UNSUPPORTED_HOOK_PROVIDER");
            }
            Path privateLock = HookLocalStorage.directory(userHome, "locks", lockDirectory);
            return withLock(privateLock, request, () -> {
                String expectedRevision = requiredString(request, "expectedRevision");
                boolean enabled = request.get("enabled").getAsBoolean();
                if (codexConfig) {
                    return toggleCodexConfig(projectRoot, request, location, expectedRevision, enabled);
                }
                return toggleClaude(projectRoot, request, location, expectedRevision, enabled);
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
            Path stateConfig = codexHome.resolve("config.toml");
            String stateRevision = Files.isRegularFile(stateConfig) ? revision(stateConfig) : "missing";
            if (!stateRevision.equals(requiredString(request, "nativeStateRevision"))) {
                return failure(request, "HOOK_REVISION_CONFLICT");
            }
            if (Files.size(target) > 128L * 1024L || Files.isRegularFile(stateConfig) && Files.size(stateConfig) > 128L * 1024L) {
                return failure(request, "SOURCE_TOO_LARGE");
            }
            String original = Files.isRegularFile(stateConfig) ? Files.readString(stateConfig, StandardCharsets.UTF_8) : "";
            String declarations = Files.readString(target, StandardCharsets.UTF_8);
            CodexHookToml.ParseResult parsed = pathPolicy.isCodexHooksJson(target, project)
                    ? CodexHookToml.parseJson(declarations, target, original) : CodexHookToml.parse(declarations, target, original);
            String key = requiredString(request, "managedKey");
            if (!parsed.valid() || parsed.entries().stream().noneMatch(entry -> key.equals(entry.managedKey()) && entry.validationIssues().isEmpty())) {
                return failure(request, "HOOK_NOT_FOUND");
            }
            if (!revision(target).equals(expectedRevision)) {
                return failure(request, "HOOK_REVISION_CONFLICT");
            }
            CodexHookToml.UpdateResult update = CodexHookToml.updateEnabled(original, key, enabled);
            if (!update.success()) {
                return failure(request, update.errorCode());
            }
            JsonObject mutation = mutationService.writeNativeState(projectRoot, stateConfig, stateRevision, update.content());
            if (!mutation.get("success").getAsBoolean()) {
                return mutation;
            }
            mutation.remove("content");
            mutation.addProperty("location", target.toString());
            mutation.addProperty("revision", revision(target));
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
        if (project != null && target.equals(project.resolve(".claude/settings.json"))
                && (!request.has("confirmSharedChange") || !request.get("confirmSharedChange").isJsonPrimitive()
                || !request.getAsJsonPrimitive("confirmSharedChange").isBoolean()
                || !request.get("confirmSharedChange").getAsBoolean())) {
            return failure(request, "HOOK_SHARED_CONFIRMATION_REQUIRED");
        }
        String sourceId = requiredString(request, "sourceId");
        String scope = requiredString(request, "scope");
        try {
            if (Files.size(target) > 128L * 1024L) {
                return failure(request, "SOURCE_TOO_LARGE");
            }
            String original = Files.readString(target, StandardCharsets.UTF_8);
            if (!revision(target).equals(expectedRevision)) {
                return failure("HOOK_REVISION_CONFLICT");
            }
            JsonObject root = JsonParser.parseString(original).getAsJsonObject();
            if (root.has("hooks") && !root.get("hooks").isJsonNull() && !root.get("hooks").isJsonObject()) {
                return failure(request, "HOOKS_NOT_OBJECT");
            }
            HookToggleStateStore store = new HookToggleStateStore(userHome, target.getParent());
            JsonObject state = store.readStrict();
            JsonArray disabled = state.getAsJsonArray("disabledClaude");
            JsonObject mutation;
            if (enabled) {
                JsonObject entry = findDisabledClaude(disabled, target, sourceId);
                if (entry == null) {
                    return failure(request, "HOOK_NOT_DISABLED");
                }
                JsonElement events = root.has("hooks") && root.get("hooks").isJsonObject()
                        ? root.getAsJsonObject("hooks").get(entry.get("event").getAsString()) : null;
                if (events != null && !events.isJsonArray()) {
                    return failure(request, "HOOK_RESTORE_CONFLICT");
                }
                if (containsClaudeHook(root, entry)) {
                    if (entry.get("wrapped").getAsBoolean() && events != null) {
                        int parentIndex = restoredEventIndex(disabled, entry, entry.get("parentIndex").getAsInt());
                        JsonArray groups = events.getAsJsonArray();
                        if (parentIndex >= 0 && parentIndex < groups.size() && groups.get(parentIndex).isJsonObject()
                                && matchesContainer(groups.get(parentIndex).getAsJsonObject(), entry)) {
                            markContainerPresent(disabled, entry, true);
                        }
                    }
                    disabled.remove(entry);
                    store.write(state);
                    JsonObject present = success();
                    present.addProperty("sourceId", sourceId);
                    present.addProperty("location", target.toString());
                    present.addProperty("enabled", true);
                    present.addProperty("statusCode", "HOOK_ALREADY_PRESENT");
                    present.addProperty("revision", expectedRevision);
                    attachRequestId(present, request);
                    return present;
                }
                if (!restoreClaudeHook(root, entry, disabled)) {
                    return failure(request, "HOOK_RESTORE_CONFLICT");
                }
                mutation = mutationService.write(projectRoot, target.toString(), expectedRevision,
                        HookJsonSource.replaceHooks(original, root.getAsJsonObject("hooks")));
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
                entry.addProperty("parentIndex", match.wrapped ? originalEventIndex(disabled, entry, match.parentIndex) : -1);
                entry.addProperty("orderIndex", match.wrapped ? originalOrderIndex(disabled, entry)
                        : originalEventIndex(disabled, entry, match.index));
                entry.add("hook", match.hook.deepCopy());
                if (match.wrapped) {
                    JsonObject container = root.getAsJsonObject("hooks").getAsJsonArray(match.event)
                            .get(match.parentIndex).getAsJsonObject().deepCopy();
                    container.remove("hooks");
                    entry.add("container", container);
                    entry.addProperty("containerRemoved", match.parent.size() == 1);
                    if (match.parent.size() == 1) {
                        markContainerPresent(disabled, entry, false);
                    }
                }
                removeClaudeHook(root, match);
                mutation = mutationService.write(projectRoot, target.toString(), expectedRevision,
                        HookJsonSource.replaceHooks(original, root.getAsJsonObject("hooks")));
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

    private static void removeClaudeHook(JsonObject root, HookMatch match) {
        match.parent.remove(match.index);
        if (match.wrapped && match.parent.isEmpty()) {
            root.getAsJsonObject("hooks").getAsJsonArray(match.event).remove(match.parentIndex);
        }
    }

    private static boolean containsClaudeHook(JsonObject root, JsonObject entry) {
        JsonElement hooks = root.get("hooks");
        if (hooks == null || !hooks.isJsonObject()) {
            return false;
        }
        JsonElement event = hooks.getAsJsonObject().get(entry.get("event").getAsString());
        if (event == null || !event.isJsonArray()) {
            return false;
        }
        boolean wrapped = entry.has("wrapped") && entry.get("wrapped").getAsBoolean();
        for (JsonElement value : event.getAsJsonArray()) {
            if (!value.isJsonObject()) {
                continue;
            }
            JsonObject candidate = value.getAsJsonObject();
            if (!wrapped && candidate.equals(entry.get("hook"))) {
                return true;
            }
            if (wrapped && Objects.equals(stringValue(entry, "matcher"), stringValue(candidate, "matcher"))
                    && candidate.has("hooks") && candidate.get("hooks").isJsonArray()) {
                for (JsonElement child : candidate.getAsJsonArray("hooks")) {
                    if (child.equals(entry.get("hook"))) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // Indices count disabled siblings too, so restore order cannot reorder handlers.
    private static int originalOrderIndex(JsonArray disabled, JsonObject entry) {
        java.util.List<Integer> removed = new java.util.ArrayList<>();
        for (JsonElement value : disabled) {
            JsonObject sibling = value.getAsJsonObject();
            if (sibling.has("orderIndex") && sameClaudeContainer(entry, sibling)) {
                removed.add(sibling.get("orderIndex").getAsInt());
            }
        }
        removed.sort(Integer::compareTo);
        int index = entry.get("index").getAsInt();
        for (int prior : removed) {
            if (prior <= index) {
                index++;
            }
        }
        return index;
    }

    private static int restoredOrderIndex(JsonArray disabled, JsonObject entry) {
        if (!entry.has("orderIndex")) {
            return entry.get("index").getAsInt();
        }
        int original = entry.get("orderIndex").getAsInt();
        int index = original;
        for (JsonElement value : disabled) {
            JsonObject sibling = value.getAsJsonObject();
            if (sibling.has("orderIndex") && sameClaudeContainer(entry, sibling)
                    && sibling.get("orderIndex").getAsInt() < original) {
                index--;
            }
        }
        return index;
    }

    private static boolean sameClaudeContainer(JsonObject first, JsonObject second) {
        for (String field : new String[] {"location", "event", "wrapped", "parentIndex"}) {
            if (!Objects.equals(first.get(field), second.get(field))) {
                return false;
            }
        }
        return true;
    }

    private static java.util.SortedSet<Integer> removedEventIndices(JsonArray disabled, JsonObject entry) {
        var indices = new java.util.TreeSet<Integer>();
        for (JsonElement value : disabled) {
            JsonObject sibling = value.getAsJsonObject();
            if (!Objects.equals(entry.get("location"), sibling.get("location"))
                    || !Objects.equals(entry.get("event"), sibling.get("event"))) {
                continue;
            }
            if (!sibling.get("wrapped").getAsBoolean()) {
                indices.add(sibling.get("orderIndex").getAsInt());
            } else if (sibling.has("containerRemoved") && sibling.get("containerRemoved").getAsBoolean()) {
                indices.add(sibling.get("parentIndex").getAsInt());
            }
        }
        return indices;
    }

    private static int originalEventIndex(JsonArray disabled, JsonObject entry, int index) {
        for (int removed : removedEventIndices(disabled, entry)) {
            if (removed <= index) { index++; }
        }
        return index;
    }

    private static int restoredEventIndex(JsonArray disabled, JsonObject entry, int original) {
        return original - removedEventIndices(disabled, entry).headSet(original).size();
    }

    private static void markContainerPresent(JsonArray disabled, JsonObject entry, boolean present) {
        for (JsonElement value : disabled) {
            JsonObject sibling = value.getAsJsonObject();
            if (sameClaudeContainer(entry, sibling)) {
                sibling.addProperty("containerRemoved", !present);
            }
        }
    }

    private static boolean matchesContainer(JsonObject candidate, JsonObject entry) {
        JsonObject metadata = candidate.deepCopy();
        metadata.remove("hooks");
        return metadata.equals(entry.get("container")) && candidate.has("hooks") && candidate.get("hooks").isJsonArray();
    }

    private static boolean restoreClaudeHook(JsonObject root, JsonObject entry, JsonArray disabled) {
        JsonObject hook = entry.getAsJsonObject("hook").deepCopy();
        String event = entry.get("event").getAsString();
        String matcher = entry.has("matcher") ? entry.get("matcher").getAsString() : null;
        int index = restoredOrderIndex(disabled, entry);
        JsonObject hooks = root.has("hooks") && root.get("hooks").isJsonObject()
                ? root.getAsJsonObject("hooks") : new JsonObject();
        if (!root.has("hooks") || root.get("hooks").isJsonNull()) {
            root.add("hooks", hooks);
        }
        JsonArray eventArray = hooks.has(event) && hooks.get(event).isJsonArray()
                ? hooks.getAsJsonArray(event) : new JsonArray();
        if (!hooks.has(event)) {
            hooks.add(event, eventArray);
        }
        if (entry.has("wrapped") && entry.get("wrapped").getAsBoolean()) {
            int parentIndex = restoredEventIndex(disabled, entry, entry.get("parentIndex").getAsInt());
            boolean removed = entry.has("containerRemoved") && entry.get("containerRemoved").getAsBoolean();
            if (!removed && parentIndex >= 0 && parentIndex < eventArray.size()) {
                JsonElement parent = eventArray.get(parentIndex);
                if (parent.isJsonObject() && matchesContainer(parent.getAsJsonObject(), entry)) {
                    insert(parent.getAsJsonObject().getAsJsonArray("hooks"), index, hook);
                    return true;
                }
            }
            if (!removed) {
                return false;
            }
            JsonObject wrapper = entry.has("container") && entry.get("container").isJsonObject()
                    ? entry.getAsJsonObject("container").deepCopy() : new JsonObject();
            if (matcher != null) {
                wrapper.addProperty("matcher", matcher);
            }
            JsonArray nested = new JsonArray();
            nested.add(hook);
            wrapper.add("hooks", nested);
            insert(eventArray, parentIndex, wrapper);
            markContainerPresent(disabled, entry, true);
            return true;
        }
        insert(eventArray, restoredEventIndex(disabled, entry, entry.get("orderIndex").getAsInt()), hook);
        return true;
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
            return target != null && (pathPolicy.isCodexConfig(target, project) || pathPolicy.isCodexHooksJson(target, project)) ? target : null;
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

    private JsonObject withLock(
            Path directory,
            JsonObject request,
            ToggleOperation operation
    ) {
        try {
            HookLocalStorage.prepare(userHome, directory);
            Path lockPath = directory.resolve(".ccgui-hooks-toggle.lock");
            if (Files.isSymbolicLink(lockPath)) {
                return failure(request, "HOOK_TOGGLE_LOCK_FAILED");
            }
            try (var lock = HookLocalStorage.tryLock(lockPath)) {
                if (lock == null) {
                    return failure(request, "HOOK_TOGGLE_LOCKED");
                }
                return operation.apply();
            }
        } catch (IOException e) {
            return failure(request, "HOOK_TOGGLE_LOCK_FAILED");
        }
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
        return HookSourceRevision.read(path);
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

}
