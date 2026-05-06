package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.service.RunConfigMonitorService;
import com.github.claudecodegui.terminal.TerminalMonitorService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Computable;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Builds message payloads and provider-specific context blocks for a session.
 */
public class SessionContextService {

    private static final Logger LOG = Logger.getInstance(SessionContextService.class);

    private final Project project;
    private final int maxFileSizeBytes;

    public SessionContextService(Project project, int maxFileSizeBytes) {
        this.project = project;
        this.maxFileSizeBytes = maxFileSizeBytes;
    }

    public ClaudeSession.Message buildUserMessage(String normalizedInput, List<ClaudeSession.Attachment> attachments) {
        ClaudeSession.Message userMessage = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, normalizedInput);

        try {
            JsonArray contentArr = new JsonArray();
            String userDisplayText = normalizedInput;

            if (attachments != null && !attachments.isEmpty()) {
                for (ClaudeSession.Attachment att : attachments) {
                    if (isImageAttachment(att)) {
                        contentArr.add(createImageBlock(att));
                    }
                }

                if (userDisplayText.isEmpty()) {
                    userDisplayText = generateAttachmentSummary(attachments);
                }
            }

            userDisplayText = processReferences(normalizedInput, "terminal", "Terminal Output", this::resolveTerminalContent);
            userDisplayText = processReferences(userDisplayText, "service", "Service Output", this::resolveServiceContent);

            contentArr.add(createTextBlock(userDisplayText));

            JsonObject messageObj = new JsonObject();
            messageObj.add("content", contentArr);
            JsonObject rawUser = new JsonObject();
            rawUser.add("message", messageObj);
            userMessage.raw = rawUser;
            userMessage.content = userDisplayText;

            LOG.info("[ClaudeSession] Created user message: content="
                    + (userDisplayText.length() > 50 ? userDisplayText.substring(0, 50) + "..." : userDisplayText)
                    + ", hasRaw=true, contentBlocks=" + contentArr.size());
        } catch (ProcessCanceledException e) {
            throw e;
        } catch (Exception e) {
            LOG.warn("Failed to build user message raw: " + e.getMessage());
        }

        return userMessage;
    }

    public String buildCodexContextAppend(JsonObject openedFilesJson, List<String> fileTagPaths) {
        StringBuilder sb = new StringBuilder();
        boolean hasContent = false;

        // 0. Workspace/Multi-project context (highest priority for project structure understanding)
        if (openedFilesJson != null && openedFilesJson.has("isWorkspace")
                && openedFilesJson.get("isWorkspace").getAsBoolean()) {
            sb.append("\n\n## Workspace Context\n\n");
            sb.append("You are working in a multi-project workspace environment.\n\n");

            if (openedFilesJson.has("workspaceRoot")) {
                sb.append("Workspace root: `").append(openedFilesJson.get("workspaceRoot").getAsString()).append("`\n\n");
            }

            if (openedFilesJson.has("subprojects")) {
                JsonArray subprojects = openedFilesJson.getAsJsonArray("subprojects");
                sb.append("Subprojects in this workspace:\n");
                for (int i = 0; i < subprojects.size(); i++) {
                    JsonObject sp = subprojects.get(i).getAsJsonObject();
                    String name = sp.has("name") ? sp.get("name").getAsString() : "unknown";
                    String path = sp.has("path") ? sp.get("path").getAsString() : "";
                    String type = sp.has("type") ? sp.get("type").getAsString() : "";
                    // Match the JS-side default in system-prompts.js: missing means loaded.
                    boolean loaded = !sp.has("loaded") || sp.get("loaded").getAsBoolean();

                    sb.append("- **").append(name).append("**");
                    if (!type.isEmpty()) {
                        sb.append(" (").append(type).append(")");
                    }
                    if (!loaded) {
                        sb.append(" [not loaded]");
                    }
                    sb.append(": `").append(path).append("`\n");
                }
                sb.append("\n");
            }

            if (openedFilesJson.has("activeSubproject")) {
                sb.append("The current file belongs to subproject: **")
                    .append(openedFilesJson.get("activeSubproject").getAsString())
                    .append("**\n\n");
            }

            sb.append("When working with files, consider which subproject they belong to. ")
                .append("Each subproject may have its own build configuration, dependencies, and codebase structure.\n");
            hasContent = true;
        }

        // Also show module info for single projects with multiple modules
        if (openedFilesJson != null && openedFilesJson.has("modules")) {
            JsonArray modules = openedFilesJson.getAsJsonArray("modules");
            if (modules.size() > 1 && (!openedFilesJson.has("isWorkspace")
                    || !openedFilesJson.get("isWorkspace").getAsBoolean())) {
                sb.append("\n\n## Project Modules\n\n");
                sb.append("This project contains multiple modules:\n");
                for (int i = 0; i < modules.size(); i++) {
                    JsonObject mod = modules.get(i).getAsJsonObject();
                    String name = mod.has("name") ? mod.get("name").getAsString() : "unknown";
                    sb.append("- `").append(name).append("`\n");
                }
                sb.append("\n");
                hasContent = true;
            }
        }

        List<String> terminalPaths = new ArrayList<>();
        List<String> regularFilePaths = new ArrayList<>();

        if (fileTagPaths != null && !fileTagPaths.isEmpty()) {
            for (String path : fileTagPaths) {
                if (path != null && path.startsWith("terminal://")) {
                    terminalPaths.add(path);
                } else {
                    regularFilePaths.add(path);
                }
            }
        }

        if (!terminalPaths.isEmpty()) {
            sb.append("\n\n## Active Terminal Session\n\n");
            sb.append("The user is working in the following terminal context:\n\n");
            for (String terminalPath : terminalPaths) {
                String sessionName = terminalPath.substring("terminal://".length());
                sb.append("- **Terminal**: `").append(sessionName).append("`\n");
            }
            sb.append("\nCommands should be executed in this terminal context.\n\n");
            hasContent = true;
        }

        if (!regularFilePaths.isEmpty()) {
            sb.append("\n\n## Referenced Files\n\n");
            sb.append("The following files were referenced by the user:\n\n");

            for (String filePath : regularFilePaths) {
                String fileContent = readFileContent(filePath);
                if (fileContent != null) {
                    String extension = getFileExtension(filePath);
                    sb.append("### `").append(filePath).append("`\n\n");
                    sb.append("```").append(extension).append("\n");
                    sb.append(fileContent);
                    if (!fileContent.endsWith("\n")) {
                        sb.append("\n");
                    }
                    sb.append("```\n\n");
                    hasContent = true;
                }
            }
        }

        if (openedFilesJson != null && !openedFilesJson.isJsonNull()) {
            String activeFile = null;
            if (openedFilesJson.has("active") && !openedFilesJson.get("active").isJsonNull()) {
                activeFile = openedFilesJson.get("active").getAsString();
            }

            JsonObject selection = null;
            String selectedText = null;
            Integer startLine = null;
            Integer endLine = null;

            if (openedFilesJson.has("selection") && openedFilesJson.get("selection").isJsonObject()) {
                selection = openedFilesJson.getAsJsonObject("selection");
                if (selection.has("selectedText") && !selection.get("selectedText").isJsonNull()) {
                    selectedText = selection.get("selectedText").getAsString();
                }
                if (selection.has("startLine") && selection.get("startLine").isJsonPrimitive()) {
                    startLine = selection.get("startLine").getAsInt();
                }
                if (selection.has("endLine") && selection.get("endLine").isJsonPrimitive()) {
                    endLine = selection.get("endLine").getAsInt();
                }
            }

            if (selectedText != null && !selectedText.trim().isEmpty()) {
                sb.append("\n\n## IDE Context\n\n");
                if (activeFile != null && !activeFile.trim().isEmpty()) {
                    sb.append("Active file: `").append(activeFile);
                    if (startLine != null && endLine != null) {
                        if (startLine.equals(endLine)) {
                            sb.append("#L").append(startLine);
                        } else {
                            sb.append("#L").append(startLine).append("-").append(endLine);
                        }
                    }
                    sb.append("`\n\n");
                }
                sb.append("Selected code:\n```\n");
                sb.append(selectedText);
                sb.append("\n```\n");
                sb.append("The selected code above is the primary subject of the user's question.\n");
                hasContent = true;
            } else if (activeFile != null && !activeFile.trim().isEmpty()) {
                String fileContent = readFileContent(activeFile);
                if (fileContent != null) {
                    String extension = getFileExtension(activeFile);
                    sb.append("\n\n## User's Current IDE Context\n\n");
                    sb.append("The user is viewing this file in their IDE. This is the PRIMARY SUBJECT of the user's question.\n\n");
                    sb.append("### `").append(activeFile).append("`\n\n");
                    sb.append("```").append(extension).append("\n");
                    sb.append(fileContent);
                    if (!fileContent.endsWith("\n")) {
                        sb.append("\n");
                    }
                    sb.append("```\n\n");
                    hasContent = true;
                    LOG.info("[Codex Context] Injected active file content: " + activeFile);
                }
            }
        }

        return hasContent ? sb.toString() : "";
    }

    private String processReferences(
            String input,
            String protocol,
            String blockTitle,
            Function<String, String> contentResolver
    ) {
        Pattern pattern = Pattern.compile("@" + protocol + "://([a-zA-Z0-9_]+)");
        Matcher matcher = pattern.matcher(input);
        StringBuffer result = new StringBuffer();
        int matchCount = 0;

        while (matcher.find()) {
            matchCount++;
            String safeName = matcher.group(1);
            LOG.debug("[" + protocol + "] Found mention in message: @" + protocol + "://" + safeName);
            String content = contentResolver.apply(safeName);

            if (content != null && !content.isEmpty()) {
                String block = "\n\n" + blockTitle + " (" + safeName + "):\n```\n" + content + "\n```";
                matcher.appendReplacement(result, Matcher.quoteReplacement(block));
                LOG.debug("[" + protocol + "] Successfully replaced reference for: " + safeName);
            } else {
                matcher.appendReplacement(result, "");
                LOG.debug("[" + protocol + "] Content was empty or null for: " + safeName);
            }
        }
        matcher.appendTail(result);

        if (matchCount == 0 && input.contains("@" + protocol + "://")) {
            LOG.warn("[" + protocol + "] Message contains '@" + protocol + "://' but regex did not match.");
        }

        return result.toString();
    }

    private String resolveTerminalContent(String safeName) {
        if (project == null) {
            return "";
        }

        return ApplicationManager.getApplication().runReadAction((Computable<String>) () -> {
            try {
                List<Object> widgets = TerminalMonitorService.getWidgets(project);
                LOG.debug("[Terminal] Resolving: " + safeName + ". Available widgets: " + widgets.size());

                Map<String, Integer> nameCounts = new HashMap<>();
                for (Object widget : widgets) {
                    String baseTitle = TerminalMonitorService.getWidgetTitle(widget);
                    int count = nameCounts.getOrDefault(baseTitle, 0) + 1;
                    nameCounts.put(baseTitle, count);

                    String titleText = baseTitle;
                    if (count > 1) {
                        titleText = baseTitle + " (" + count + ")";
                    }

                    String widgetSafeName = titleText.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    LOG.debug("[Terminal] - Candidate: " + titleText + " (Safe: " + widgetSafeName + ")");

                    if (widgetSafeName.equals(safeName)) {
                        String content = TerminalMonitorService.getWidgetContent(widget);
                        LOG.debug("[Terminal] Match found! Content length: "
                                + (content != null ? content.length() : "null"));
                        return content;
                    }
                }
                LOG.debug("[Terminal] No matching terminal found for: " + safeName);
            } catch (ProcessCanceledException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("[Terminal] Error resolving terminal content: " + e.getMessage(), e);
            }
            return "";
        });
    }

    private String resolveServiceContent(String safeName) {
        if (project == null) {
            return "";
        }

        return ApplicationManager.getApplication().runReadAction((Computable<String>) () -> {
            try {
                List<RunConfigMonitorService.RunConfigInfo> configs =
                        RunConfigMonitorService.getRunConfigurations(project);
                LOG.debug("[Service] Resolving: " + safeName + ". Available configs: " + configs.size());

                for (RunConfigMonitorService.RunConfigInfo config : configs) {
                    String displayName = config.getDisplayName();
                    String widgetSafeName = displayName.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    LOG.debug("[Service] - Candidate: " + displayName + " (Safe: " + widgetSafeName + ")");

                    if (widgetSafeName.equals(safeName)) {
                        String content = config.getContent();
                        LOG.debug("[Service] Match found! Content length: "
                                + (content != null ? content.length() : "null"));
                        return content;
                    }
                }
                LOG.debug("[Service] No matching service found for: " + safeName);
            } catch (ProcessCanceledException e) {
                throw e;
            } catch (Exception e) {
                LOG.error("[Service] Error resolving service content: " + e.getMessage(), e);
            }
            return "";
        });
    }

    private boolean isImageAttachment(ClaudeSession.Attachment att) {
        if (att == null) {
            return false;
        }
        String mediaType = att.mediaType != null ? att.mediaType : "";
        return mediaType.startsWith("image/") && att.data != null;
    }

    private JsonObject createImageBlock(ClaudeSession.Attachment att) {
        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");

        JsonObject source = new JsonObject();
        source.addProperty("type", "base64");
        source.addProperty("media_type", att.mediaType);
        source.addProperty("data", att.data);
        imageBlock.add("source", source);

        return imageBlock;
    }

    private JsonObject createTextBlock(String text) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        return textBlock;
    }

    private String generateAttachmentSummary(List<ClaudeSession.Attachment> attachments) {
        int imageCount = 0;
        List<String> names = new ArrayList<>();

        for (ClaudeSession.Attachment att : attachments) {
            if (att != null && att.fileName != null && !att.fileName.isEmpty()) {
                names.add(att.fileName);
            }
            String mediaType = att != null && att.mediaType != null ? att.mediaType : "";
            if (mediaType.startsWith("image/")) {
                imageCount++;
            }
        }

        if (names.isEmpty()) {
            if (imageCount > 0) {
                return "[Uploaded " + imageCount + " image(s)]";
            }
            return "[Uploaded attachment(s)]";
        }

        if (names.size() > 3) {
            return "[Uploaded Attachments: " + String.join(", ", names.subList(0, 3)) + ", ...]";
        }
        return "[Uploaded Attachments: " + String.join(", ", names) + "]";
    }

    private String readFileContent(String filePath) {
        try {
            File file = new File(filePath);
            if (!file.exists() || !file.isFile() || !file.canRead()) {
                LOG.warn("[Codex Context] File not accessible: " + filePath);
                return null;
            }

            long fileSize = file.length();
            if (fileSize > maxFileSizeBytes) {
                LOG.info("[Codex Context] File too large, reading first "
                        + (maxFileSizeBytes / 1024)
                        + "KB: " + filePath + " (" + fileSize + " bytes)");
                try (FileInputStream fis = new FileInputStream(file)) {
                    byte[] buffer = new byte[maxFileSizeBytes];
                    int bytesRead = fis.read(buffer);
                    if (bytesRead > 0) {
                        return new String(buffer, 0, bytesRead, StandardCharsets.UTF_8)
                                + "\n\n... (file truncated, showing first "
                                + (maxFileSizeBytes / 1024)
                                + "KB of " + (fileSize / 1024) + "KB)";
                    }
                }
                return null;
            }

            String content = Files.readString(file.toPath(), StandardCharsets.UTF_8);
            LOG.info("[Codex Context] Read file content: " + filePath + " (" + fileSize + " bytes)");
            return content;
        } catch (Exception e) {
            LOG.warn("[Codex Context] Failed to read file: " + filePath + ", error: " + e.getMessage());
            return null;
        }
    }

    private String getFileExtension(String filePath) {
        if (filePath == null) {
            return "";
        }
        int lastDot = filePath.lastIndexOf('.');
        if (lastDot > 0 && lastDot < filePath.length() - 1) {
            return filePath.substring(lastDot + 1).toLowerCase();
        }
        return "";
    }
}
