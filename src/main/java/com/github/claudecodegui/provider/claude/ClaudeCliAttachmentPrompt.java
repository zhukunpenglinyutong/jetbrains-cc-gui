package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.session.ClaudeSession;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Formats disk-backed attachments for Claude CLI prompts.
 */
final class ClaudeCliAttachmentPrompt {

    static final String IMAGE_ATTACHMENT_PREFIX = "[Image #";

    private ClaudeCliAttachmentPrompt() {
    }

    static Rendered render(String message, List<ResolvedAttachment> attachments) {
        StringBuilder promptBuilder = new StringBuilder(message != null ? message : "");
        List<String> addDirs = new ArrayList<>();

        if (attachments == null || attachments.isEmpty()) {
            return new Rendered(promptBuilder.toString(), addDirs);
        }

        for (ResolvedAttachment resolved : attachments) {
            if (resolved == null || resolved.attachment() == null || resolved.file() == null) {
                continue;
            }

            File file = resolved.file();
            File parentDir = file.getParentFile();
            if (parentDir != null && parentDir.isDirectory()) {
                String dirPath = parentDir.getAbsolutePath();
                if (!addDirs.contains(dirPath)) {
                    addDirs.add(dirPath);
                }
            }

            ClaudeSession.Attachment attachment = resolved.attachment();
            String safePath = toPromptPath(file);
            if (isImageAttachment(attachment)) {
                promptBuilder.append("\n\n").append(IMAGE_ATTACHMENT_PREFIX)
                        .append(resolved.displayIndex()).append(": ").append(safePath)
                        .append("]\n").append("Use the Read tool to inspect this image file, then answer using its visible content: ")
                        .append(safePath);
            } else {
                promptBuilder.append("\n\n[Attached file: ")
                        .append(attachment.fileName)
                        .append("]\nPlease use the Read tool to read the file at: ")
                        .append(safePath);
            }
        }

        return new Rendered(promptBuilder.toString(), addDirs);
    }

    private static String toPromptPath(File file) {
        return file.getAbsolutePath().replace('\\', '/');
    }

    private static boolean isImageAttachment(ClaudeSession.Attachment attachment) {
        if (attachment.mediaType != null && attachment.mediaType.startsWith("image/")) {
            return true;
        }
        if (attachment.fileName != null) {
            String lower = attachment.fileName.toLowerCase(Locale.ROOT);
            return lower.endsWith(".png")
                    || lower.endsWith(".jpg")
                    || lower.endsWith(".jpeg")
                    || lower.endsWith(".gif")
                    || lower.endsWith(".webp")
                    || lower.endsWith(".bmp");
        }
        return false;
    }

    record ResolvedAttachment(int displayIndex, ClaudeSession.Attachment attachment, File file) {
    }

    record Rendered(String prompt, List<String> addDirs) {
    }
}
