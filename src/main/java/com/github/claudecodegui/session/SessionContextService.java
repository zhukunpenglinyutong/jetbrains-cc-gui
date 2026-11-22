package com.github.claudecodegui.session;

import com.github.claudecodegui.service.RunConfigMonitorService;
import com.github.claudecodegui.terminal.TerminalMonitorService;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Computable;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Builds message payloads and provider-specific context blocks for a session.
 */
public class SessionContextService {

    private static final Logger LOG = Logger.getInstance(SessionContextService.class);

    private final Project project;

    public SessionContextService(Project project) {
        this.project = project;
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

    /** Keeps changing editor references separate from the user's native message. */
    public JsonObject buildCodexAdditionalContext(
            JsonObject openedFilesJson,
            List<String> fileTagPaths,
            UnaryOperator<String> toNodePath
    ) {
        Map<String, String> sections = this.buildMessageContext(withNodePaths(openedFilesJson, toNodePath), null, false);
        // Native limits apply per fragment, so explicit references must not share a budget with editor state.
        if (fileTagPaths != null) {
            for (int index = 0; index < fileTagPaths.size(); index++) {
                String path = fileTagPaths.get(index);
                if (path != null) {
                    String reference = path.startsWith("terminal://") ? path : toNodePath.apply(path);
                    for (Map.Entry<String, String> section : this.buildMessageContext(null, List.of(reference), false).entrySet()) {
                        sections.put(section.getKey() + "_" + index, section.getValue());
                    }
                }
            }
        }
        JsonObject fragments = new JsonObject();
        for (Map.Entry<String, String> section : sections.entrySet()) {
            JsonObject editorContext = new JsonObject();
            editorContext.addProperty("kind", "application");
            editorContext.addProperty("value", section.getValue().strip());
            fragments.add(section.getKey(), editorContext);
        }
        return fragments;
    }

    /** Codex runs where node runs, so inside WSL it can only open Linux paths. */
    private static JsonObject withNodePaths(JsonObject openedFilesJson, UnaryOperator<String> toNodePath) {
        if (openedFilesJson == null) {
            return null;
        }
        JsonObject converted = openedFilesJson.deepCopy();
        if (converted.has("active") && !converted.get("active").isJsonNull()) {
            converted.addProperty("active", toNodePath.apply(converted.get("active").getAsString()));
        }
        if (converted.has("others") && converted.get("others").isJsonArray()) {
            JsonArray others = new JsonArray();
            for (JsonElement other : converted.getAsJsonArray("others")) {
                others.add(toNodePath.apply(other.getAsString()));
            }
            converted.add("others", others);
        }
        if (converted.has("subprojects") && converted.get("subprojects").isJsonArray()) {
            for (JsonElement subproject : converted.getAsJsonArray("subprojects")) {
                JsonObject entry = subproject.getAsJsonObject();
                if (entry.has("path")) {
                    entry.addProperty("path", toNodePath.apply(entry.get("path").getAsString()));
                }
            }
        }
        return converted;
    }

    /** Preserves the existing module context for other CLI providers. */
    public String buildLegacyContextAppend(JsonObject openedFilesJson, List<String> fileTagPaths) {
        return String.join("", this.buildMessageContext(openedFilesJson, fileTagPaths, true).values());
    }

    /** Combines role instructions and project modules for native thread initialization and cold resume. */
    public String buildCodexSessionInstructions(String roleInstructions, JsonObject openedFilesJson) {
        String modules = buildProjectModules(openedFilesJson);
        if (modules.isEmpty()) {
            return roleInstructions;
        }
        return (roleInstructions == null || roleInstructions.isBlank() ? "" : roleInstructions + "\n\n") + modules.stripLeading();
    }

    private static String buildProjectModules(JsonObject openedFilesJson) {
        if (openedFilesJson == null || !openedFilesJson.has("modules") || !openedFilesJson.get("modules").isJsonArray()
                || openedFilesJson.has("isWorkspace") && openedFilesJson.get("isWorkspace").getAsBoolean()) {
            return "";
        }
        JsonArray modules = openedFilesJson.getAsJsonArray("modules");
        if (modules.size() <= 1) {
            return "";
        }
        StringBuilder context = new StringBuilder("\n\n## Project Modules\n\nThis project contains multiple modules:\n");
        for (JsonElement element : modules) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject module = element.getAsJsonObject();
            context.append("- `").append(module.has("name") ? module.get("name").getAsString() : "unknown").append("`\n");
        }
        return context.append('\n').toString();
    }

    private Map<String, String> buildMessageContext(JsonObject openedFilesJson, List<String> fileTagPaths, boolean includeModules) {
        Map<String, String> sections = new LinkedHashMap<>();
        StringBuilder sb = new StringBuilder();

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
            sections.put("workspace_context", sb.toString());
            sb.setLength(0);
        }

        if (includeModules) {
            String modules = buildProjectModules(openedFilesJson);
            if (!modules.isEmpty()) {
                sections.put("project_modules", modules);
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
            sections.put("terminal_context", sb.toString());
            sb.setLength(0);
        }

        if (!regularFilePaths.isEmpty()) {
            // Path references only: CLI providers are agentic and read files
            // themselves. Never inline file content here — it bloats every
            // prompt and overflows the Windows command-line length limit
            // (32,767 chars) when the prompt is passed as a CLI argument.
            sb.append("\n\n## Referenced Files\n\n");
            sb.append("The following files were referenced by the user:\n\n");
            for (String filePath : regularFilePaths) {
                sb.append("- `").append(filePath).append("`\n");
            }
            sb.append("\nRead them with your file tools as needed; ")
                .append("the user expects answers based on their content.\n");
            sections.put("referenced_files", sb.toString());
            sb.setLength(0);
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

            if (selectedText != null && !selectedText.trim().isEmpty()
                    && activeFile != null && !activeFile.trim().isEmpty()) {
                // Reference the selection by path + line range only; the agent
                // reads the file itself. Never inline selected code either.
                sb.append("\n\n## IDE Context\n\n");
                sb.append("Active file: `").append(activeFile);
                if (startLine != null && endLine != null) {
                    if (startLine.equals(endLine)) {
                        sb.append("#L").append(startLine);
                    } else {
                        sb.append("#L").append(startLine).append("-").append(endLine);
                    }
                }
                sb.append("`\n\n");
                if (includeModules) {
                    sb.append("The user has selected the referenced lines in this file; ")
                        .append("the selection is the primary subject of the user's question. ")
                        .append("Read the file to see the selected code.\n");
                } else {
                    sb.append("The user has selected these lines in the editor. Read them if relevant to the request.\n");
                }
            } else if (activeFile != null && !activeFile.trim().isEmpty()) {
                sb.append("\n\n## User's Current IDE Context\n\n");
                sb.append("The user is viewing this file in their IDE. ");
                sb.append(includeModules ? "This is the PRIMARY SUBJECT of the user's question: `" : "Active file: `")
                    .append(activeFile).append("`\n\n");
                sb.append("Read it with your file tools as needed.\n");
                LOG.info("[Codex Context] Referenced active file: " + activeFile);
            }
            if (sb.length() > 0) {
                sections.put("ide_context", sb.toString());
                sb.setLength(0);
            }
            if (!includeModules && openedFilesJson.has("others") && openedFilesJson.get("others").isJsonArray()) {
                JsonArray openTabs = openedFilesJson.getAsJsonArray("others");
                if (!openTabs.isEmpty()) {
                    sb.append("\n\n## Other Open Tabs\n\n");
                    // Paths provide orientation without copying potentially unsaved or unrelated code.
                    for (int index = 0; index < Math.min(openTabs.size(), 20); index++) {
                        sb.append("- `").append(openTabs.get(index).getAsString()).append("`\n");
                    }
                    if (openTabs.size() > 20) {
                        sb.append("Additional open tabs omitted.\n");
                    }
                    sections.put("open_tabs", sb.toString());
                }
            }
        }

        return sections;
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
}
