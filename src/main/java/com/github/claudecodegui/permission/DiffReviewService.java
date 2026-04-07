package com.github.claudecodegui.permission;

import com.github.claudecodegui.handler.diff.DiffResult;
import com.github.claudecodegui.handler.diff.InteractiveDiffManager;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.google.gson.JsonObject;
import com.google.gson.JsonArray;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.util.Computable;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Service for reviewing file-modifying tool calls (Edit, MultiEdit, Write)
 * via an interactive diff view.
 * Integrates with the permission system to provide "review-before-write" capability.
 *
 * This service computes the proposed file content from tool inputs, opens an interactive
 * diff view in the IDE, and returns the user's decision (accept/reject) along with the
 * possibly user-edited content.
 */
public class DiffReviewService {

    private static final Logger LOG = Logger.getInstance(DiffReviewService.class);

    /** Tool names that modify files and should trigger diff review */
    private static final Set<String> FILE_MODIFYING_TOOLS = Set.of("Edit", "MultiEdit", "Write");

    /**
     * Check if a tool is a file-modifying tool that should trigger diff review.
     */
    public static boolean isFileModifyingTool(@Nullable String toolName) {
        return toolName != null && FILE_MODIFYING_TOOLS.contains(toolName);
    }

    /**
     * Review a file change by opening an interactive diff view.
     * Reads the original file, computes the proposed content, and opens the diff.
     *
     * @param project  The current project
     * @param toolName The tool name (Edit, Write, etc.)
     * @param inputs   The tool input parameters
     * @return CompletableFuture resolving to the review result, or null if diff review is not possible
     */
    @Nullable
    public static CompletableFuture<DiffReviewResult> reviewFileChange(
            @NotNull Project project,
            @NotNull String toolName,
            @NotNull JsonObject inputs
    ) {
        String filePath = extractFilePath(inputs);
        if (filePath == null || filePath.isEmpty()) {
            LOG.warn("DiffReview: No file path found in tool inputs for " + toolName);
            return null;
        }

        // Security: validate file path is within project directory
        String projectBasePath = project.getBasePath();
        if (projectBasePath != null) {
            try {
                String canonicalFile = new File(filePath).getCanonicalPath();
                String canonicalBase = new File(projectBasePath).getCanonicalPath();
                if (!canonicalFile.startsWith(canonicalBase + File.separator)
                        && !canonicalFile.equals(canonicalBase)) {
                    LOG.warn("DiffReview: Security - file path outside project: " + filePath);
                    return null;
                }
            } catch (IOException e) {
                LOG.warn("DiffReview: Security - failed to validate path: " + filePath, e);
                return null;
            }
        }

        LOG.info("DiffReview: Starting review for " + toolName + " on " + filePath);

        try {
            String originalContent = readFileContent(filePath);
            String proposedContent = computeProposedContent(toolName, inputs, originalContent, filePath);

            if (proposedContent == null) {
                LOG.warn("DiffReview: Could not compute proposed content for " + toolName);
                return null;
            }

            boolean isNewFile = (originalContent == null);
            String safeOriginal = originalContent != null ? originalContent : "";

            // Build tab name
            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.reviewTabName", fileName);

            // Create the diff request (read-only: permission review is preview-only)
            InteractiveDiffRequest request;
            if (isNewFile) {
                request = InteractiveDiffRequest.forReadOnlyNewFile(filePath, proposedContent, tabName);
            } else {
                request = InteractiveDiffRequest.forReadOnlyModifiedFile(filePath, safeOriginal, proposedContent, tabName);
            }

            // Open the interactive diff and map the result
            CompletableFuture<DiffResult> diffFuture = InteractiveDiffManager.showInteractiveDiff(project, request);

            return diffFuture.thenApply(diffResult -> {
                if (diffResult.isApplied()) {
                    LOG.info("DiffReview: User accepted changes for " + filePath
                            + (diffResult.isAppliedAlways() ? " (always allow)" : ""));
                    return diffResult.isAppliedAlways()
                            ? DiffReviewResult.acceptedAlways(diffResult.getFinalContent(), filePath)
                            : DiffReviewResult.accepted(diffResult.getFinalContent(), filePath);
                } else {
                    String action = diffResult.isRejected() ? "rejected" : "dismissed";
                    LOG.info("DiffReview: User " + action + " changes for " + filePath);
                    return DiffReviewResult.rejected(filePath);
                }
            });
        } catch (Exception e) {
            LOG.error("DiffReview: Failed to set up diff review for " + filePath, e);
            return null;
        }
    }

    /**
     * Extract the file path from tool inputs.
     * Supports Edit (file_path), MultiEdit (file_path), Write (file_path),
     * and NotebookEdit (notebook_path).
     */
    @Nullable
    private static String extractFilePath(@NotNull JsonObject inputs) {
        if (inputs.has("file_path") && !inputs.get("file_path").isJsonNull()) {
            return inputs.get("file_path").getAsString();
        }
        if (inputs.has("notebook_path") && !inputs.get("notebook_path").isJsonNull()) {
            return inputs.get("notebook_path").getAsString();
        }
        if (inputs.has("path") && !inputs.get("path").isJsonNull()) {
            return inputs.get("path").getAsString();
        }
        return null;
    }

    /**
     * Read the content of a file. Returns null if the file does not exist.
     */
    @Nullable
    private static String readFileContent(@NotNull String filePath) {
        return ApplicationManager.getApplication().runReadAction((Computable<String>) () -> {
            try {
                VirtualFile vFile = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(filePath.replace('\\', '/'));
                if (vFile != null && vFile.exists() && !vFile.isDirectory()) {
                    Charset charset = vFile.getCharset() != null ? vFile.getCharset() : StandardCharsets.UTF_8;
                    return new String(vFile.contentsToByteArray(), charset);
                }
            } catch (IOException e) {
                LOG.warn("DiffReview: Failed to read file: " + filePath, e);
            }
            return null;
        });
    }

    /**
     * Compute the proposed file content based on tool name and inputs.
     *
     * @param toolName        The tool name
     * @param inputs          The tool input parameters
     * @param originalContent The original file content (null if file doesn't exist)
     * @return The proposed new content, or null if computation fails
     */
    @Nullable
    private static String computeProposedContent(
            @NotNull String toolName,
            @NotNull JsonObject inputs,
            @Nullable String originalContent,
            @NotNull String filePath
    ) {
        switch (toolName) {
            case "Edit":
                return computeEditProposedContent(inputs, originalContent, filePath);
            case "MultiEdit":
                return computeMultiEditProposedContent(inputs, originalContent, filePath);
            case "Write":
                return computeWriteProposedContent(inputs);
            default:
                return null;
        }
    }

    /**
     * Compute proposed content for the Edit tool.
     * Replaces old_string with new_string in the original content.
     */
    @Nullable
    private static String computeEditProposedContent(
            @NotNull JsonObject inputs,
            @Nullable String originalContent,
            @NotNull String filePath
    ) {
        if (originalContent == null) {
            LOG.warn("DiffReview: Edit tool called on non-existent file: " + filePath);
            return null;
        }

        String oldString = extractString(inputs, "old_string", "oldString");
        String newString = extractString(inputs, "new_string", "newString");
        if (oldString == null || newString == null) {
            LOG.warn("DiffReview: Edit tool missing old_string or new_string for " + filePath);
            return null;
        }

        boolean replaceAll = extractBoolean(inputs, "replace_all", "replaceAll");
        return applySingleEdit(originalContent, oldString, newString, replaceAll, filePath, "Edit");
    }

    /**
     * Compute proposed content for the MultiEdit tool.
     * Applies multiple old_string/new_string replacements in order.
     */
    @Nullable
    private static String computeMultiEditProposedContent(
            @NotNull JsonObject inputs,
            @Nullable String originalContent,
            @NotNull String filePath
    ) {
        if (originalContent == null) {
            LOG.warn("DiffReview: MultiEdit tool called on non-existent file: " + filePath);
            return null;
        }

        if (!inputs.has("edits") || !inputs.get("edits").isJsonArray()) {
            LOG.warn("DiffReview: MultiEdit tool missing edits array for " + filePath);
            return null;
        }

        JsonArray edits = inputs.getAsJsonArray("edits");
        String content = originalContent;
        for (int i = 0; i < edits.size(); i++) {
            if (!edits.get(i).isJsonObject()) {
                LOG.warn("DiffReview: MultiEdit edit[" + i + "] is not an object for " + filePath);
                return null;
            }

            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = extractString(edit, "old_string", "oldString");
            String newString = extractString(edit, "new_string", "newString");
            if (oldString == null || newString == null) {
                LOG.warn("DiffReview: MultiEdit edit[" + i + "] missing old/new string for " + filePath);
                return null;
            }

            boolean replaceAll = extractBoolean(edit, "replace_all", "replaceAll");
            String nextContent = applySingleEdit(
                    content, oldString, newString, replaceAll, filePath, "MultiEdit[" + i + "]");
            if (nextContent == null) {
                return null;
            }
            content = nextContent;
        }
        return content;
    }

    @Nullable
    private static String applySingleEdit(
            @NotNull String content,
            @NotNull String oldString,
            @NotNull String newString,
            boolean replaceAll,
            @NotNull String filePath,
            @NotNull String operationLabel
    ) {
        // No-op edit: old and new are identical
        if (oldString.equals(newString)) {
            return content;
        }

        if (!replaceAll) {
            // Try exact match first
            int index = content.indexOf(oldString);
            String effectiveOld = oldString;
            String effectiveNew = newString;

            // Fallback: try line-ending variants (Windows CRLF/LF mismatch)
            if (index < 0) {
                String[] variant = findLineEndingVariant(content, oldString, newString);
                if (variant != null) {
                    effectiveOld = variant[0];
                    effectiveNew = variant[1];
                    index = content.indexOf(effectiveOld);
                    LOG.info("DiffReview: Matched old_string after normalizing " + variant[2]
                            + " for " + operationLabel + " on " + filePath);
                }
            }

            if (index >= 0) {
                return content.substring(0, index)
                        + effectiveNew
                        + content.substring(index + effectiveOld.length());
            }

            LOG.warn("DiffReview: old_string not found in file content for " + operationLabel
                    + " on " + filePath + " (fileLength=" + content.length()
                    + ", oldStringLength=" + oldString.length() + ")");
            return null;
        }

        // For replace_all: try exact match first
        String result = content.replace(oldString, newString);
        if (!result.equals(content)) {
            return result;
        }

        // Fallback: try line-ending variants to avoid silent no-ops
        String[] variant = findLineEndingVariant(content, oldString, newString);
        if (variant != null) {
            result = content.replace(variant[0], variant[1]);
            if (!result.equals(content)) {
                LOG.info("DiffReview: Matched old_string after normalizing " + variant[2]
                        + " (replace_all) for " + operationLabel + " on " + filePath);
                return result;
            }
        }

        LOG.warn("DiffReview: old_string not found in file content for " + operationLabel
                + " on " + filePath + " (replace_all, fileLength=" + content.length()
                + ", oldStringLength=" + oldString.length() + ")");
        return null;
    }

    @Nullable
    private static String extractString(@NotNull JsonObject json, @NotNull String primaryKey, @NotNull String fallbackKey) {
        if (json.has(primaryKey) && !json.get(primaryKey).isJsonNull()) {
            return json.get(primaryKey).getAsString();
        }
        if (json.has(fallbackKey) && !json.get(fallbackKey).isJsonNull()) {
            return json.get(fallbackKey).getAsString();
        }
        return null;
    }

    private static boolean extractBoolean(@NotNull JsonObject json, @NotNull String primaryKey, @NotNull String fallbackKey) {
        if (json.has(primaryKey) && !json.get(primaryKey).isJsonNull()) {
            return json.get(primaryKey).getAsBoolean();
        }
        return json.has(fallbackKey) && !json.get(fallbackKey).isJsonNull() && json.get(fallbackKey).getAsBoolean();
    }

    /**
     * Find a line-ending variant of oldString that exists in content.
     * Tries LF->CRLF and CRLF->LF conversions to handle Windows/Unix line ending mismatches.
     *
     * @return [effectiveOld, effectiveNew, variantDescription] if a variant matches, null otherwise
     */
    @Nullable
    private static String[] findLineEndingVariant(
            @NotNull String content, @NotNull String oldString, @NotNull String newString) {
        // Try LF -> CRLF (tool sends LF, file uses CRLF)
        String crlfOld = oldString.replace("\n", "\r\n");
        if (!crlfOld.equals(oldString) && content.contains(crlfOld)) {
            return new String[]{crlfOld, newString.replace("\n", "\r\n"), "LF->CRLF"};
        }
        // Try CRLF -> LF (tool sends CRLF, file uses LF)
        String lfOld = oldString.replace("\r\n", "\n");
        if (!lfOld.equals(oldString) && content.contains(lfOld)) {
            return new String[]{lfOld, newString.replace("\r\n", "\n"), "CRLF->LF"};
        }
        return null;
    }

    /**
     * Compute proposed content for the Write tool.
     * The Write tool provides the complete new file content.
     */
    @Nullable
    private static String computeWriteProposedContent(@NotNull JsonObject inputs) {
        if (inputs.has("content") && !inputs.get("content").isJsonNull()) {
            return inputs.get("content").getAsString();
        }
        LOG.warn("DiffReview: Write tool missing content field");
        return null;
    }
}
