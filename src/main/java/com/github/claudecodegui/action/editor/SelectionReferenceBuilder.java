package com.github.claudecodegui.action.editor;

import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Objects;

public class SelectionReferenceBuilder {

    public @NotNull Result build(@Nullable Editor editor, @Nullable VirtualFile file) {
        if (editor == null) {
            return Result.failure("send.cannotGetEditor");
        }
        if (file == null) {
            return Result.failure("send.cannotGetFile");
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();
        if (isBlank(selectedText)) {
            return Result.failure("send.selectCodeFirst");
        }

        Document document = editor.getDocument();
        int startOffset = selectionModel.getSelectionStart();
        int endOffset = selectionModel.getSelectionEnd();
        int startLine = document.getLineNumber(startOffset) + 1;
        int endLine = document.getLineNumber(endOffset) + 1;
        if (endLine > startLine && editor.offsetToLogicalPosition(endOffset).column == 0) {
            endLine--;
        }
        return buildFromRawSelection(selectedText, file.getPath(), startLine, endLine);
    }

    @NotNull Result buildFromRawSelection(@Nullable String selectedText, @Nullable String absolutePath, int startLine, int endLine) {
        if (isBlank(selectedText)) {
            return Result.failure("send.selectCodeFirst");
        }
        if (isBlank(absolutePath)) {
            return Result.failure("send.cannotGetFilePath");
        }

        String normalizedPath = absolutePath.trim();
        String reference = startLine == endLine ? "@" + normalizedPath + "#L" + startLine : "@" + normalizedPath + "#L" + startLine + "-" + endLine;
        return Result.success(reference);
    }

    private static boolean isBlank(@Nullable String value) {
        return value == null || value.trim().isEmpty();
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

        public static Result success(@NotNull String reference) {
            return new Result(true, Objects.requireNonNull(reference, "reference"), null);
        }

        public static Result failure(String messageKey) {
            return new Result(false, null, messageKey);
        }

        public boolean isSuccess() {
            return success;
        }

        public @Nullable String getReference() {
            return reference;
        }

        public @Nullable String getMessageKey() {
            return messageKey;
        }
    }
}
