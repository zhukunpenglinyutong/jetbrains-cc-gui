package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Builds the request payload shared by daemon and per-process Claude sends.
 */
class ClaudeRequestParamsBuilder {

    private final Gson gson;

    ClaudeRequestParamsBuilder(Gson gson) {
        this.gson = gson;
    }

    JsonObject buildSendParams(
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            String permissionMode,
            String model,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort
    ) {
        JsonObject params = new JsonObject();
        params.addProperty("message", message);
        params.addProperty("sessionId", sessionId != null ? sessionId : "");
        params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
        params.addProperty("cwd", cwd != null ? cwd : "");
        params.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        params.addProperty("model", model != null ? model : "");

        JsonArray attachmentArray = serializeAttachments(attachments);
        if (attachmentArray != null && attachmentArray.size() > 0) {
            params.add("attachments", attachmentArray);
        }

        if (openedFiles != null && openedFiles.size() > 0) {
            params.add("openedFiles", openedFiles);
        }
        if (agentPrompt != null && !agentPrompt.isEmpty()) {
            params.addProperty("agentPrompt", agentPrompt);
        }
        if (streaming != null) {
            params.addProperty("streaming", streaming);
        }
        if (disableThinking != null && disableThinking) {
            params.addProperty("disableThinking", true);
        }
        if (reasoningEffort != null && !reasoningEffort.trim().isEmpty()) {
            params.addProperty("reasoningEffort", reasoningEffort);
        }

        return params;
    }

    private JsonArray serializeAttachments(List<ClaudeSession.Attachment> attachments) {
        if (attachments == null || attachments.isEmpty()) {
            return null;
        }

        List<Map<String, String>> serializable = new ArrayList<>();
        for (ClaudeSession.Attachment att : attachments) {
            if (att == null) {
                continue;
            }
            Map<String, String> obj = new LinkedHashMap<>();
            obj.put("fileName", att.fileName);
            obj.put("mediaType", att.mediaType);
            obj.put("data", att.data);
            serializable.add(obj);
        }

        if (serializable.isEmpty()) {
            return null;
        }
        return gson.fromJson(gson.toJson(serializable), JsonArray.class);
    }
}
