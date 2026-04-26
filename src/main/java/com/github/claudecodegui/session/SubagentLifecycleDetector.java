package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Detects provider-neutral sub-agent lifecycle events from normalized messages. */
public final class SubagentLifecycleDetector {

    private static final Pattern UUID_PATTERN = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    private final Map<String, ToolUseInfo> toolUseById = new HashMap<>();
    private final Set<String> startedToolUseIds = new HashSet<>();
    private final Set<String> terminalToolUseIds = new HashSet<>();

    public List<SubagentLifecycleEvent> handleAssistant(String provider, JsonObject raw) {
        List<SubagentLifecycleEvent> events = new ArrayList<>();
        for (JsonObject block : contentBlocks(raw)) {
            if (!isType(block, "tool_use")) {
                continue;
            }
            String id = getString(block, "id");
            String name = normalizeName(getString(block, "name"));
            JsonObject input = block.has("input") && block.get("input").isJsonObject()
                    ? block.getAsJsonObject("input")
                    : new JsonObject();
            if (id == null || name == null || terminalToolUseIds.contains(id)) {
                continue;
            }
            toolUseById.put(id, new ToolUseInfo(name, input));
            if (isStartTool(provider, name) && startedToolUseIds.add(id)) {
                events.add(new SubagentLifecycleEvent(
                        SubagentLifecycleEvent.Kind.STARTED,
                        provider,
                        id,
                        id,
                        extractAgentHandle(input),
                        "start:" + id
                ));
            }
        }
        return events;
    }

    public List<SubagentLifecycleEvent> handleUser(String provider, JsonObject raw) {
        List<SubagentLifecycleEvent> events = new ArrayList<>();
        for (JsonObject block : contentBlocks(raw)) {
            if (!isType(block, "tool_result")) {
                continue;
            }
            String toolUseId = getString(block, "tool_use_id");
            if (toolUseId == null) {
                continue;
            }
            ToolUseInfo info = toolUseById.get(toolUseId);
            if (info == null) {
                continue;
            }
            if (isErroredToolResult(block)) {
                toolUseById.remove(toolUseId);
                terminalToolUseIds.add(toolUseId);
                if (shouldCancelScope(provider, info.name())) {
                    events.add(new SubagentLifecycleEvent(
                            SubagentLifecycleEvent.Kind.CANCELLED,
                            provider,
                            toolUseId,
                            toolUseId,
                            resolveTerminalAgentHandle(info.name(), info.input(), block),
                            "cancel:" + toolUseId
                    ));
                }
                continue;
            }
            if ("claude".equals(provider) && ("task".equals(info.name()) || "agent".equals(info.name()))) {
                events.add(new SubagentLifecycleEvent(
                        SubagentLifecycleEvent.Kind.COMPLETED,
                        provider,
                        toolUseId,
                        toolUseId,
                        extractAgentHandle(info.input()),
                        "complete:" + toolUseId
                ));
                toolUseById.remove(toolUseId);
                terminalToolUseIds.add(toolUseId);
            } else if ("codex".equals(provider) && "spawn_agent".equals(info.name())) {
                String agentHandle = firstNonBlank(extractAgentHandleFromSpawnResult(block), extractAgentHandle(info.input()));
                if (agentHandle != null) {
                    events.add(new SubagentLifecycleEvent(
                            SubagentLifecycleEvent.Kind.SPAWN_RESOLVED,
                            provider,
                            toolUseId,
                            toolUseId,
                            agentHandle,
                            "spawn_resolved:" + toolUseId
                    ));
                } else {
                    events.add(new SubagentLifecycleEvent(
                            SubagentLifecycleEvent.Kind.CANCELLED,
                            provider,
                            toolUseId,
                            toolUseId,
                            null,
                            "spawn_unresolved:" + toolUseId
                    ));
                }
                toolUseById.remove(toolUseId);
                terminalToolUseIds.add(toolUseId);
            } else if ("codex".equals(provider) && ("wait_agent".equals(info.name()) || "close_agent".equals(info.name()))) {
                String agentHandle = resolveTerminalAgentHandle(info.name(), info.input(), block);
                if (agentHandle != null) {
                    events.add(new SubagentLifecycleEvent(
                            SubagentLifecycleEvent.Kind.COMPLETED,
                            provider,
                            toolUseId,
                            null,
                            agentHandle,
                            "complete:" + toolUseId
                    ));
                }
                toolUseById.remove(toolUseId);
                terminalToolUseIds.add(toolUseId);
            } else {
                toolUseById.remove(toolUseId);
                terminalToolUseIds.add(toolUseId);
            }
        }
        return events;
    }

    private static boolean isErroredToolResult(JsonObject block) {
        if (block == null || !block.has("is_error") || block.get("is_error").isJsonNull()) {
            return false;
        }
        try {
            return block.get("is_error").getAsBoolean();
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isStartTool(String provider, String name) {
        return ("claude".equals(provider) && ("task".equals(name) || "agent".equals(name)))
                || ("codex".equals(provider) && ("spawn_agent".equals(name)
                || "resume_agent".equals(name) || "send_input".equals(name)));
    }

    private static boolean shouldCancelScope(String provider, String name) {
        return ("claude".equals(provider) && ("task".equals(name) || "agent".equals(name)))
                || ("codex".equals(provider) && ("spawn_agent".equals(name)
                || "wait_agent".equals(name) || "close_agent".equals(name)
                || "resume_agent".equals(name) || "send_input".equals(name)));
    }

    private static List<JsonObject> contentBlocks(JsonObject raw) {
        if (raw == null) {
            return List.of();
        }
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : raw;
        if (!message.has("content") || !message.get("content").isJsonArray()) {
            return List.of();
        }
        JsonArray content = message.getAsJsonArray("content");
        List<JsonObject> blocks = new ArrayList<>();
        for (JsonElement element : content) {
            if (element.isJsonObject()) {
                blocks.add(element.getAsJsonObject());
            }
        }
        return blocks;
    }

    private static boolean isType(JsonObject block, String type) {
        return type.equals(getString(block, "type"));
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String normalizeName(String name) {
        return name == null ? null : name.trim().toLowerCase(Locale.ROOT);
    }

    private static String extractAgentHandle(JsonObject input) {
        if (input == null) {
            return null;
        }
        return firstNonBlank(
                getString(input, "agentHandle"),
                getString(input, "agent_handle"),
                getString(input, "agentId"),
                getString(input, "agent_id"),
                getString(input, "agentPath"),
                getString(input, "agent_path"),
                getString(input, "target")
        );
    }

    private static String extractSingleTargetArrayHandle(JsonObject input) {
        if (input == null || !input.has("targets") || !input.get("targets").isJsonArray()) {
            return null;
        }
        JsonArray targets = input.getAsJsonArray("targets");
        String handle = null;
        for (JsonElement target : targets) {
            if (!target.isJsonPrimitive()) {
                continue;
            }
            String value;
            try {
                value = target.getAsString();
            } catch (Exception e) {
                continue;
            }
            if (value == null || value.isBlank()) {
                continue;
            }
            if (handle != null) {
                return null;
            }
            handle = value;
        }
        return handle;
    }

    private static String resolveTerminalAgentHandle(String toolName, JsonObject input, JsonObject resultBlock) {
        String directInputHandle = extractAgentHandle(input);
        String resultHandle = extractAgentHandleFromToolResult(resultBlock);
        if ("wait_agent".equals(toolName)) {
            return firstNonBlank(resultHandle, directInputHandle, extractSingleTargetArrayHandle(input));
        }
        return firstNonBlank(directInputHandle, resultHandle);
    }

    private static String extractAgentHandleFromToolResult(JsonObject block) {
        String content = getString(block, "content");
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (parsed.isJsonObject()) {
                return extractAgentHandle(parsed.getAsJsonObject());
            }
        } catch (Exception ignored) {
            // Fall back to text extraction.
        }
        Matcher matcher = UUID_PATTERN.matcher(content);
        String match = null;
        while (matcher.find()) {
            if (match != null) {
                return null;
            }
            match = matcher.group();
        }
        return match;
    }


    private static String extractAgentHandleFromSpawnResult(JsonObject block) {
        String structured = extractAgentHandleFromToolResult(block);
        if (structured != null) {
            return structured;
        }
        String content = getString(block, "content");
        if (content == null) {
            return null;
        }
        String trimmed = content.trim();
        if (!isPlausiblePlainTextHandle(trimmed)) {
            return null;
        }
        return trimmed;
    }

    private static boolean isPlausiblePlainTextHandle(String value) {
        if (value == null || value.isBlank() || value.length() > 512 || value.contains("\n")) {
            return false;
        }
        if (value.startsWith("/") || value.startsWith("~/") || value.matches("^[A-Za-z]:[\\/].*")) {
            return true;
        }
        if (value.matches("^[A-Za-z0-9._:-]+$")) {
            String lower = value.toLowerCase(Locale.ROOT);
            return lower.contains("agent") || lower.contains("codex") || value.matches(".*[0-9a-fA-F]{6,}.*");
        }
        return false;
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private record ToolUseInfo(String name, JsonObject input) {
    }
}
