package com.github.claudecodegui.service;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.VirtualFile;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Service to handle Quick Fix response processing and Diff application.
 */
public class QuickFixService {
    private static final Logger LOG = Logger.getInstance(QuickFixService.class);

    // Maximum response size to process with regex (1MB)
    private static final int MAX_RESPONSE_SIZE = 1024 * 1024;

    public static void handleAIResponse(Project project, Editor editor, String response) {
        // Guard against extremely large responses that could cause regex performance issues
        if (response == null || response.isEmpty()) {
            LOG.warn("Quick Fix: Empty response received");
            return;
        }

        final String processedResponse;
        final boolean wasTruncated;
        if (response.length() > MAX_RESPONSE_SIZE) {
            LOG.warn("Quick Fix: Response too large (" + response.length() + " bytes), truncating for safety");
            processedResponse = response.substring(0, MAX_RESPONSE_SIZE);
            wasTruncated = true;
        } else {
            processedResponse = response;
            wasTruncated = false;
        }

        // Extract code block
        Pattern pattern = Pattern.compile("```(?:java|javascript|typescript|js|ts|html|css|python|py)?\\s*([\\s\\S]*?)```");
        Matcher matcher = pattern.matcher(processedResponse);

        if (matcher.find()) {
            final String newCode = matcher.group(1).trim();
            final com.intellij.openapi.editor.SelectionModel selectionModel = editor.getSelectionModel();

            final String oldCode;
            final int startOffset;
            final int endOffset;

            if (selectionModel.hasSelection()) {
                oldCode = selectionModel.getSelectedText();
                startOffset = selectionModel.getSelectionStart();
                endOffset = selectionModel.getSelectionEnd();
                LOG.info("Quick Fix: Using selection for diff (lines " +
                    (editor.getDocument().getLineNumber(startOffset)+1) + "-" +
                    (editor.getDocument().getLineNumber(endOffset)+1) + ")");
            } else {
                oldCode = editor.getDocument().getText();
                startOffset = 0;
                endOffset = editor.getDocument().getTextLength();
                LOG.info("Quick Fix: Using full file for diff");
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                // Warn user if response was truncated - code block may be incomplete
                if (wasTruncated) {
                    ClaudeNotifier.showWarning(project,
                        "Response was truncated due to size limit. The suggested code may be incomplete.");
                }
                showDiffAndApply(project, editor, oldCode, newCode, startOffset, endOffset);
            });
        } else {
            // No code block found
            if (wasTruncated) {
                // If truncated and no code block found, the code block was likely cut off
                ApplicationManager.getApplication().invokeLater(() -> {
                    ClaudeNotifier.showWarning(project,
                        "Response was too large and truncated. No complete code block could be extracted.");
                });
            } else {
                LOG.info("Quick Fix: No code block found in response, skipping dialog");
            }
        }

        ClaudeNotifier.clearStatus(project);
    }

    private static void showDiffAndApply(Project project, Editor editor, String oldCode, String newCode, int startOffset, int endOffset) {
        Document document = editor.getDocument();
        VirtualFile file = FileDocumentManager.getInstance().getFile(document);
        if (file == null) return;
        
        String fileName = file.getName();
        FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

        // Sanity check: If we are replacing the whole file with a very short snippet, warn the user
        if (startOffset == 0 && endOffset == document.getTextLength() && newCode.length() < oldCode.length() * 0.3) {
            String message = "The suggestion seems to be a snippet rather than the full file.\n" +
                             "Applying this will replace your entire file with just this snippet.\n\n" +
                             "Do you want to continue?";
            int answer = Messages.showYesNoDialog(project, message, "Warning: Possible Partial Response", Messages.getWarningIcon());
            if (answer != Messages.YES) return;
        }

        // Create Diff contents
        DiffContent leftContent = DiffContentFactory.getInstance().create(project, oldCode != null ? oldCode : "", fileType);
        DiffContent rightContent = DiffContentFactory.getInstance().create(project, newCode, fileType);

        // Create Diff request
        SimpleDiffRequest diffRequest = new SimpleDiffRequest(
            "Quick Fix Proposed Changes",
            leftContent,
            rightContent,
            "Original",
            "Fixed by Claude"
        );

        // Show diff
        ApplicationManager.getApplication().invokeLater(() -> {
            DiffManager.getInstance().showDiff(project, diffRequest);
            
            // Ask to apply after showing diff
            int result = Messages.showOkCancelDialog(
                project,
                "Would you like to apply the proposed changes " + 
                (startOffset == 0 && endOffset == document.getTextLength() ? "to " + fileName : "to the selection") + "?",
                "Apply Quick Fix",
                "Apply",
                "Cancel",
                Messages.getQuestionIcon()
            );
            
            if (result == Messages.OK) {
                WriteCommandAction.runWriteCommandAction(project, "Apply Claude Quick Fix", null, () -> {
                    document.replaceString(startOffset, endOffset, newCode);
                });
            }
        });
    }
}
