package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.AttachmentStorageService;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

/**
 * CLI 附件处理器：
 * 1. 将附件备份到 AttachmentStorageService（content-addressed store），避免 temp 删除导致历史回显失败。
 * 2. 为 Claude CLI 生成磁盘文件路径（在 prompt 中引用 + --add-dir 授权），
 *    Claude CLI 没有 stdin content-block 协议，base64 占位文本起不到任何作用，必须给真实可读的文件路径。
 * 3. 为 Codex CLI 生成磁盘文件路径（-i flag）。
 */
public class CliAttachmentHandler {

    private static final Logger LOG = Logger.getInstance(CliAttachmentHandler.class);

    private final AttachmentStorageService storage = AttachmentStorageService.getInstance();

    /**
     * 处理附件列表，返回 Claude CLI 可直接读取的磁盘文件描述。
     * 图片：返回带 file 的 IMAGE block；文档/文本：返回带 text 的 TEXT block。
     * 同时把图片备份到持久化存储，保证历史回显仍可用。
     * tempFiles 用于收集临时文件（仅当持久化失败时），调用方需在完成后清理。
     */
    public List<ContentBlock> processForClaude(
            String provider,
            String sessionKey,
            List<ClaudeSession.Attachment> attachments,
            List<File> tempFiles
    ) {
        List<ContentBlock> blocks = new ArrayList<>();
        if (attachments == null || attachments.isEmpty()) {
            LOG.info("[ClaudeImageDiag][CliAttachmentHandler] processForClaude: no attachments" + ", provider=" + provider + ", sessionKey=" + sessionKey);
            return blocks;
        }
        LOG.info("[ClaudeImageDiag][CliAttachmentHandler] processForClaude: attachments=" + attachments.size() + ", provider=" + provider + ", sessionKey=" + sessionKey);

        for (ClaudeSession.Attachment att : attachments) {
            if (att == null) {
                LOG.warn("[ClaudeImageDiag][CliAttachmentHandler] skip null attachment");
                continue;
            }
            try {
                if (isImage(att)) {
                    File file = resolvePersistentImageFile(provider, sessionKey, att);
                    if (file == null) {
                        file = resolveToFile(att, tempFiles);
                    }
                    if (file != null && file.isFile()) {
                        blocks.add(new ContentBlock(ContentBlock.Kind.IMAGE, att.mediaType, file, null));
                        LOG.info("[ClaudeImageDiag][CliAttachmentHandler] " + "image block created: fileName=" + att.fileName + ", mediaType=" + att.mediaType + ", localPath=" + att.localPath + ", resolvedFile=" + file.getAbsolutePath() + ", exists=" + file.isFile() + ", data=" + (att.data != null ? att.data.length() + "chars" : "null"));
                    } else {
                        LOG.warn("[ClaudeImageDiag][CliAttachmentHandler] " + "image attachment could not resolve to file: " + "fileName=" + att.fileName + ", mediaType=" + att.mediaType + ", localPath=" + att.localPath + ", data=" + (att.data != null ? att.data.length() + "chars" : "null"));
                    }
                } else {
                    // 文档/文本：读取内容作为 text block
                    String text = resolveTextContent(att);
                    if (text == null) {
                        LOG.warn("[ClaudeImageDiag][CliAttachmentHandler] " + "text attachment could not resolve content: " + "fileName=" + att.fileName + ", mediaType=" + att.mediaType + ", localPath=" + att.localPath);
                        continue;
                    }
                    blocks.add(new ContentBlock(ContentBlock.Kind.TEXT,
                            null, null,
                            "[File: " + att.fileName + "]\n" + text));
                    LOG.info("[ClaudeImageDiag][CliAttachmentHandler] " + "text block created: fileName=" + att.fileName + ", mediaType=" + att.mediaType + ", textChars=" + text.length());
                }
            } catch (Exception e) {
                LOG.warn("[CliAttachmentHandler] Failed to process attachment: " + att.fileName, e);
                LOG.warn("[ClaudeImageDiag][CliAttachmentHandler] exception while processing attachment: fileName=" + att.fileName + ", mediaType=" + att.mediaType + ", localPath=" + att.localPath, e);
            }
        }
        LOG.info("[ClaudeImageDiag][CliAttachmentHandler] processForClaude result: blocks=" + blocks.size());
        return blocks;
    }

    /**
     * 处理附件列表，返回 Codex CLI 所需的磁盘文件路径（仅图片）。
     * 优先使用已持久化的 localPath，否则写入临时文件。
     * tempFiles 列表用于调用方在完成后清理临时文件。
     */
    public List<File> processForCodex(
            List<ClaudeSession.Attachment> attachments,
            List<File> tempFiles
    ) throws Exception {
        List<File> files = new ArrayList<>();
        if (attachments == null || attachments.isEmpty()) {
            return files;
        }

        for (ClaudeSession.Attachment att : attachments) {
            if (att == null || !isImage(att)) {
                continue;
            }
            File file = resolveToFile(att, tempFiles);
            if (file != null && file.isFile()) {
                files.add(file);
            }
        }
        return files;
    }

    // ── private helpers ──────────────────────────────────────────────────────

    /** 备份图片到持久化存储并返回该磁盘文件；失败返回 null。 */
    private File resolvePersistentImageFile(String provider, String sessionKey, ClaudeSession.Attachment att) {
        // 优先复用 attachment 自带的 localPath（持久化历史回显场景）
        if (att.localPath != null && !att.localPath.isBlank()) {
            File existing = new File(att.localPath);
            if (existing.isFile()) {
                return existing;
            }
        }
        String base64 = resolveBase64(att);
        if (base64 == null) {
            return null;
        }
        try {
            AttachmentStorageService.PersistedAttachment persisted =
                    storage.persistImageAttachment(provider, sessionKey, att.fileName, att.mediaType, base64);
            if (persisted != null && persisted.localPath() != null) {
                File f = new File(persisted.localPath());
                if (f.isFile()) {
                    return f;
                }
            }
        } catch (Exception e) {
            LOG.warn("[CliAttachmentHandler] persist image failed: " + att.fileName, e);
        }
        return null;
    }

    private String resolveBase64(ClaudeSession.Attachment att) {
        if (att.data != null && !att.data.isBlank()) {
            return att.data;
        }
        if (att.localPath != null && !att.localPath.isBlank()) {
            try {
                byte[] bytes = Files.readAllBytes(new File(att.localPath).toPath());
                return Base64.getEncoder().encodeToString(bytes);
            } catch (Exception e) {
                LOG.warn("[CliAttachmentHandler] Cannot read localPath: " + att.localPath);
            }
        }
        return null;
    }

    private String resolveTextContent(ClaudeSession.Attachment att) {
        if (att.localPath != null && !att.localPath.isBlank()) {
            try {
                return Files.readString(new File(att.localPath).toPath(), StandardCharsets.UTF_8);
            } catch (Exception ignored) {
            }
        }
        if (att.data != null && !att.data.isBlank()) {
            try {
                byte[] bytes = Base64.getDecoder().decode(att.data);
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private File resolveToFile(ClaudeSession.Attachment att, List<File> tempFiles) throws Exception {
        if (att.localPath != null && !att.localPath.isBlank()) {
            File f = new File(att.localPath);
            if (f.isFile()) {
                return f;
            }
        }
        if (att.data == null || att.data.isBlank()) {
            return null;
        }
        // PR #1191 review M3: put CLI temp attachments under the same managed
        // directory as the rest of the plugin so cleanupTempFiles' allow-list
        // covers them and they don't pollute the system /tmp.
        File tempDir = new ProcessManager().prepareClaudeTempDir();
        File tmp = tempDir != null
                ? File.createTempFile("cli-att-", getExt(att.mediaType, att.fileName), tempDir)
                : File.createTempFile("cli-att-", getExt(att.mediaType, att.fileName));
        byte[] data = Base64.getDecoder().decode(att.data);
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(data);
        }
        tempFiles.add(tmp);
        return tmp;
    }

    public static boolean isImage(ClaudeSession.Attachment att) {
        if (att.mediaType != null && att.mediaType.startsWith("image/")) {
            return true;
        }
        if (att.fileName == null) {
            return false;
        }
        String lower = att.fileName.toLowerCase(Locale.ROOT);
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".bmp");
    }

    private static String getExt(String mediaType, String fileName) {
        if (fileName != null && fileName.contains(".")) {
            return fileName.substring(fileName.lastIndexOf('.'));
        }
        if (mediaType == null) {
            return ".png";
        }
        if (mediaType.contains("jpeg") || mediaType.contains("jpg")) {
            return ".jpg";
        }
        if (mediaType.contains("gif")) {
            return ".gif";
        }
        if (mediaType.contains("webp")) {
            return ".webp";
        }
        return ".png";
    }

    // ── value types ──────────────────────────────────────────────────────────

    /**
     * content block 描述。
     * IMAGE: file = 真实磁盘文件路径（prompt 中以 "[Image #N: <abs_path>]" 锚定历史，
     * 并提示 CLI 用 Read 读取；通过 --add-dir 授权父目录）。
     * TEXT:  text = 文档纯文本内容。
     */
    public record ContentBlock(Kind kind, String mediaType, File file, String text) {
        public enum Kind { IMAGE, TEXT }
    }
}
