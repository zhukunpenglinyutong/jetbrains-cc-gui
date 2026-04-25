package com.github.claudecodegui.action.editor;

import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.LogicalPosition;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

public class SelectionReferenceBuilder {

    public @NotNull Result build(@Nullable Editor editor, @Nullable VirtualFile file) {
        if (editor == null) {
            return Result.failure("send.cannotGetEditor");
        }
        if (file == null) {
            return Result.failure("send.cannotGetFile");
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        Document document = editor.getDocument();
        if (selectionModel == null || document == null) {
            return Result.failure("send.cannotGetEditor");
        }

        String selectedText = selectionModel.getSelectedText();
        int startOffset = selectionModel.getSelectionStart();
        int endOffset = selectionModel.getSelectionEnd();
        int startLine = document.getLineNumber(startOffset) + 1;
        int endLine = document.getLineNumber(endOffset) + 1;
        LogicalPosition endPosition = editor.offsetToLogicalPosition(endOffset);
        if (endLine > startLine && endPosition != null && endPosition.column == 0) {
            endLine--;
        }
        return buildFromRawSelection(selectedText, file.getPath(), startLine, endLine);
    }

    @NotNull Result buildFromRawSelection(@Nullable String selectedText, @Nullable String absolutePath, int startLine, int endLine) {
        if (selectedText == null || selectedText.trim().isEmpty()) {
            return Result.failure("send.selectCodeFirst");
        }
        if (absolutePath == null || absolutePath.trim().isEmpty()) {
            return Result.failure("send.cannotGetFilePath");
        }

        String normalizedPath = absolutePath.trim();
        String reference = startLine == endLine
                ? "@" + normalizedPath + "#L" + startLine
                : "@" + normalizedPath + "#L" + startLine + "-" + endLine;
        return Result.success(reference);
    }

    public static final class Result {
        private final boolean success;
        private final String reference;
        private final String messageKey;

        private Result(boolean success, String reference, String messageKey) {
            this.success = success;
            this.reference = reference;
            this.messageKey = messageKey;
        }

        public static Result success(String reference) {
            return new Result(true, reference, null);
        }

        public static Result failure(String messageKey) {
            return new Result(false, null, messageKey);
        }

        public boolean isSuccess() {
            return success;
        }

        public String getReference() {
            return reference;
        }

        public String getMessageKey() {
            return messageKey;
        }
    }
}
