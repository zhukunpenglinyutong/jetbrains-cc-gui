package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;

/**
 * Builds the request payload shared by daemon and per-process Claude sends.
 */
class ClaudeRequestParamsBuilder {

    private static final Predicate<String> UNTRUSTED = cwd -> false;

    private final Gson gson;
    private volatile Predicate<String> projectTrust = UNTRUSTED;

    ClaudeRequestParamsBuilder(Gson gson) {
        this.gson = gson;
    }

    void setProjectTrust(Predicate<String> projectTrust) {
        this.projectTrust = projectTrust != null ? projectTrust : UNTRUSTED;
    }

    /** Whether project settings may load for a request that runs in {@code cwd}. */
    boolean isProjectTrusted(String cwd) {
        try {
            return projectTrust.test(cwd);
        } catch (RuntimeException error) {
            return false;
        }
    }

    /** A request's working directory in the form Node runs in, and whether project settings may load there. */
    record RequestCwd(String nodeCwd, boolean projectTrusted) {
    }

    /**
     * Decides trust on the IDE's form of {@code ideCwd}, then converts it for Node.
     *
     * <p>The project base path is in the IDE's form. On WSL the converted cwd ({@code /mnt/c/...},
     * {@code /home/...}) names the same directory but cannot be compared with it, so the check
     * runs before the conversion and the request carries the converted form of the same path.
     */
    RequestCwd resolveRequestCwd(String ideCwd, UnaryOperator<String> toNodeCwd) {
        return new RequestCwd(toNodeCwd.apply(ideCwd), isProjectTrusted(ideCwd));
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
            String reasoningEffort,
            boolean projectTrusted
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
        params.addProperty("projectTrusted", projectTrusted);

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
