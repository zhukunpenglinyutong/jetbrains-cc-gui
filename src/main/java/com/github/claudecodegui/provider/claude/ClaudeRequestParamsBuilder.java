package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Builds the request payload shared by daemon and per-process Claude sends.
 */
class ClaudeRequestParamsBuilder {

    private static final Logger LOG = Logger.getInstance(ClaudeRequestParamsBuilder.class);

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
            String reasoningEffort,
            List<File> tempFiles
    ) {
        JsonObject params = new JsonObject();
        params.addProperty("message", message);
        params.addProperty("sessionId", sessionId != null ? sessionId : "");
        params.addProperty("runtimeSessionEpoch", runtimeSessionEpoch != null ? runtimeSessionEpoch : "");
        params.addProperty("cwd", cwd != null ? cwd : "");
        params.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        params.addProperty("model", model != null ? model : "");

        JsonArray attachmentArray = serializeAttachments(attachments, tempFiles);
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

    /**
     * 将附件 base64 数据写入临时文件，序列化时只传文件路径。
     * 这样 stdin JSON 不会包含巨大的 base64 字符串，避免 Windows 管道缓冲区溢出。
     */
    private JsonArray serializeAttachments(List<ClaudeSession.Attachment> attachments, List<File> tempFiles) {
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

            // 图片类型：写入临时文件，只传路径
            String mt = att.mediaType != null ? att.mediaType : "";
            if (mt.startsWith("image/") && att.data != null && !att.data.isEmpty()) {
                try {
                    File imageFile = null;
                    if (att.localPath != null && !att.localPath.isEmpty()) {
                        File persisted = new File(att.localPath);
                        if (persisted.isFile()) {
                            imageFile = persisted;
                        }
                    }
                    if (imageFile == null) {
                        imageFile = writeBase64ToTempFile(att.data, mt);
                    }
                    if (imageFile != null) {
                        obj.put("path", imageFile.getAbsolutePath());
                        if (att.localPath == null || !imageFile.getAbsolutePath().equals(att.localPath)) {
                            tempFiles.add(imageFile);
                        }
                    } else {
                        // 写入失败，回退到内联 base64
                        obj.put("data", att.data);
                    }
                } catch (Exception e) {
                    LOG.warn("[ClaudeParams] Failed to write image temp file, falling back to inline base64", e);
                    obj.put("data", att.data);
                }
            } else {
                obj.put("data", att.data);
            }

            serializable.add(obj);
        }

        if (serializable.isEmpty()) {
            return null;
        }
        return gson.fromJson(gson.toJson(serializable), JsonArray.class);
    }

    private File writeBase64ToTempFile(String base64Data, String mediaType) {
        try {
            File tempDir = new File(System.getProperty("java.io.tmpdir"), "cc-gui-images");
            if (!tempDir.exists() && !tempDir.mkdirs()) {
                LOG.warn("[ClaudeParams] Failed to create temp dir: " + tempDir.getAbsolutePath());
                return null;
            }

            String ext = getImageExtension(mediaType);
            String filename = "claude-img-" + System.currentTimeMillis()
                    + "-" + UUID.randomUUID().toString().substring(0, 8) + ext;
            File imageFile = new File(tempDir, filename);

            byte[] imageBytes = java.util.Base64.getDecoder().decode(base64Data);
            try (FileOutputStream fos = new FileOutputStream(imageFile)) {
                fos.write(imageBytes);
            }

            imageFile.deleteOnExit();
            LOG.debug("[ClaudeParams] Wrote image temp file: " + imageFile.getAbsolutePath()
                    + " (" + imageBytes.length + " bytes)");
            return imageFile;
        } catch (Exception e) {
            LOG.warn("[ClaudeParams] Failed to write image to temp file: " + e.getMessage());
            return null;
        }
    }

    private static String getImageExtension(String mediaType) {
        if (mediaType == null) return ".png";
        if (mediaType.contains("jpeg") || mediaType.contains("jpg")) return ".jpg";
        if (mediaType.contains("gif")) return ".gif";
        if (mediaType.contains("webp")) return ".webp";
        if (mediaType.contains("bmp")) return ".bmp";
        if (mediaType.contains("svg")) return ".svg";
        return ".png";
    }

    static void cleanupTempImages(List<File> tempFiles) {
        if (tempFiles == null || tempFiles.isEmpty()) {
            return;
        }
        for (File file : tempFiles) {
            try {
                if (file.exists() && file.delete()) {
                    LOG.debug("[ClaudeParams] Cleaned up temp image: " + file.getName());
                }
            } catch (Exception e) {
                LOG.debug("[ClaudeParams] Failed to cleanup temp image: " + e.getMessage());
            }
        }
    }
}
