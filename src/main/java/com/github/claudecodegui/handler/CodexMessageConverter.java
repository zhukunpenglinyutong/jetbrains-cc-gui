package com.github.claudecodegui.handler;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Codex message format conversion utilities.
 * <p>
 * Contains all pure static methods for converting Codex message formats to Claude-compatible
 * frontend formats. Extracted from HistoryHandler to improve separation of concerns.
 * <p>
 * These methods have no state and do not depend on any handler context.
 */
public class CodexMessageConverter {

    private CodexMessageConverter() {
        // Utility class, no instantiation
    }

    /**
     * Convert Codex content to Claude-format content blocks.
     * Codex: [{type: "input_text", text: "..."}, {type: "text", text: "..."}]
     * Claude: [{type: "text", text: "..."}]
     */
    public static JsonArray convertToClaudeContentBlocks(JsonElement contentElem) {
        JsonArray claudeBlocks = new JsonArray();

        if (contentElem == null) {
            return claudeBlocks;
        }

        // Handle string type - convert to a single text block
        if (contentElem.isJsonPrimitive()) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", contentElem.getAsString());
            claudeBlocks.add(textBlock);
            return claudeBlocks;
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();
                    String type = itemObj.has("type") ? itemObj.get("type").getAsString() : null;

                    if (type != null) {
                        JsonObject claudeBlock = new JsonObject();

                        // Convert Codex "input_text" and "output_text" to Claude "text"
                        if ("input_text".equals(type) || "output_text".equals(type) || "text".equals(type)) {
                            claudeBlock.addProperty("type", "text");
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool use (if present in Codex)
                        else if ("tool_use".equals(type)) {
                            claudeBlock.addProperty("type", "tool_use");
                            if (itemObj.has("id")) {
                                claudeBlock.addProperty("id", itemObj.get("id").getAsString());
                            }
                            if (itemObj.has("name")) {
                                claudeBlock.addProperty("name", itemObj.get("name").getAsString());
                            }
                            if (itemObj.has("input")) {
                                claudeBlock.add("input", itemObj.get("input"));
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool result
                        else if ("tool_result".equals(type)) {
                            claudeBlock.addProperty("type", "tool_result");
                            if (itemObj.has("tool_use_id")) {
                                claudeBlock.addProperty("tool_use_id", itemObj.get("tool_use_id").getAsString());
                            }
                            if (itemObj.has("content")) {
                                claudeBlock.add("content", itemObj.get("content"));
                            }
                            if (itemObj.has("is_error")) {
                                claudeBlock.addProperty("is_error", itemObj.get("is_error").getAsBoolean());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle thinking block
                        else if ("thinking".equals(type)) {
                            claudeBlock.addProperty("type", "thinking");
                            if (itemObj.has("thinking")) {
                                claudeBlock.addProperty("thinking", itemObj.get("thinking").getAsString());
                            }
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle image
                        else if ("image".equals(type)) {
                            claudeBlock.addProperty("type", "image");
                            if (itemObj.has("src")) {
                                claudeBlock.addProperty("src", itemObj.get("src").getAsString());
                            }
                            if (itemObj.has("mediaType")) {
                                claudeBlock.addProperty("mediaType", itemObj.get("mediaType").getAsString());
                            }
                            if (itemObj.has("alt")) {
                                claudeBlock.addProperty("alt", itemObj.get("alt").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Other unknown types, try to keep as-is
                        else {
                            claudeBlocks.add(itemObj);
                        }
                    }
                }
            }

            return claudeBlocks;
        }

        // Handle object type - treat as a single block
        if (contentElem.isJsonObject()) {
            claudeBlocks.add(contentElem.getAsJsonObject());
            return claudeBlocks;
        }

        return claudeBlocks;
    }

    /**
     * Extract text content from a Codex content field.
     * Codex content can be in string, object, or array format.
     */
    public static String extractContentAsString(JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        // Handle string type
        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();

                    // Extract text type
                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract input_text type (Codex user messages)
                    else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract output_text type (Codex AI assistant messages)
                    else if (itemObj.has("type") && "output_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            return sb.toString();
        }

        // Handle object type
        if (contentElem.isJsonObject()) {
            JsonObject contentObj = contentElem.getAsJsonObject();
            if (contentObj.has("text")) {
                return contentObj.get("text").getAsString();
            }
        }

        return null;
    }

    /**
     * Convert Codex regular message to frontend format.
     */
    public static JsonObject convertCodexMessageToFrontend(JsonObject payload, String timestamp) {
        String contentStr = extractContentAsString(payload.get("content"));

        // Filter out system messages
        if (contentStr != null && isSystemMessage(contentStr)) {
            return null;
        }

        JsonObject frontendMsg = new JsonObject();
        String role = payload.has("role") ? payload.get("role").getAsString() : "user";
        frontendMsg.addProperty("type", role);

        if (payload.has("content")) {
            if (contentStr != null && !contentStr.isEmpty()) {
                frontendMsg.addProperty("content", contentStr);
            }

            JsonArray claudeContentBlocks = convertToClaudeContentBlocks(payload.get("content"));
            JsonObject rawObj = new JsonObject();
            rawObj.add("content", claudeContentBlocks);
            rawObj.addProperty("role", role);
            frontendMsg.add("raw", rawObj);
        }

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Check if this is a system message (should be filtered).
     */
    public static boolean isSystemMessage(String contentStr) {
        return contentStr.startsWith("Warning:") ||
               contentStr.startsWith("Tool result:") ||
               contentStr.startsWith("Exit code:") ||
               contentStr.startsWith("# AGENTS.md instructions") ||
               contentStr.startsWith("<INSTRUCTIONS>") ||
               contentStr.startsWith("<environment_context>");
    }

    /**
     * Convert Codex function_call to Claude tool_use format.
     */
    public static JsonObject convertFunctionCallToToolUse(JsonObject payload, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");

        String toolName = payload.has("name") ? payload.get("name").getAsString() : "unknown";
        JsonElement toolInput = parseToolArguments(payload);

        // Smart tool name conversion
        toolName = convertToolName(toolName, toolInput);
        toolInput = convertToolInput(toolName, toolInput);

        // Build tool_use format
        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");
        toolUse.addProperty("name", toolName);

        if (toolInput != null) {
            toolUse.add("input", toolInput);
        }

        JsonArray content = new JsonArray();
        content.add(toolUse);

        frontendMsg.addProperty("content", "Tool: " + toolName);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Parse tool call arguments.
     */
    public static JsonElement parseToolArguments(JsonObject payload) {
        if (!payload.has("arguments")) {
            return null;
        }
        try {
            return JsonParser.parseString(payload.get("arguments").getAsString());
        } catch (Exception e) {
            return new JsonObject();
        }
    }

    /**
     * Smart tool name conversion (shell_command -> read/glob, update_plan -> todowrite).
     */
    public static String convertToolName(String toolName, JsonElement toolInput) {
        if ("shell_command".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("command")) {
                String command = inputObj.get("command").getAsString().trim();
                if (command.matches("^(ls|pwd|find|cat|head|tail|file|stat|tree)\\b.*")) {
                    return "read";
                } else if (command.matches("^(grep|rg|ack|ag)\\b.*")) {
                    return "glob";
                }
            }
        }
        if ("update_plan".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("plan") && inputObj.get("plan").isJsonArray()) {
                return "todowrite";
            }
        }
        return toolName;
    }

    /**
     * Convert tool input (update_plan -> todowrite format conversion).
     */
    public static JsonElement convertToolInput(String toolName, JsonElement toolInput) {
        if (!"todowrite".equals(toolName) || toolInput == null || !toolInput.isJsonObject()) {
            return toolInput;
        }

        JsonObject inputObj = toolInput.getAsJsonObject();
        if (!inputObj.has("plan") || !inputObj.get("plan").isJsonArray()) {
            return toolInput;
        }

        JsonArray planArray = inputObj.getAsJsonArray("plan");
        JsonArray todosArray = new JsonArray();

        for (int j = 0; j < planArray.size(); j++) {
            if (planArray.get(j).isJsonObject()) {
                JsonObject planItem = planArray.get(j).getAsJsonObject();
                JsonObject todoItem = new JsonObject();

                if (planItem.has("step")) {
                    todoItem.addProperty("content", planItem.get("step").getAsString());
                    todoItem.addProperty("activeForm", planItem.get("step").getAsString());
                }
                todoItem.addProperty("status", planItem.has("status") ? planItem.get("status").getAsString() : "pending");
                todoItem.addProperty("id", String.valueOf(j));

                todosArray.add(todoItem);
            }
        }

        JsonObject newInput = new JsonObject();
        newInput.add("todos", todosArray);
        return newInput;
    }

    /**
     * Convert Codex function_call_output to Claude tool_result format.
     */
    public static JsonObject convertFunctionCallOutputToToolResult(JsonObject payload, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");

        JsonObject toolResult = new JsonObject();
        toolResult.addProperty("type", "tool_result");
        toolResult.addProperty("tool_use_id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");

        String output = payload.has("output") ? payload.get("output").getAsString() : "";
        toolResult.addProperty("content", output);

        JsonArray content = new JsonArray();
        content.add(toolResult);

        frontendMsg.addProperty("content", "[tool_result]");

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }
}
