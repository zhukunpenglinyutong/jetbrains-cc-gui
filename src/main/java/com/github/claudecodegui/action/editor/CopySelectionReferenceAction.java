package com.github.claudecodegui.action.editor;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.awt.Toolkit;
import java.awt.datatransfer.StringSelection;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * Action that copies the current editor selection as an AI reference string.
 * Uses the shared selection reference builder so clipboard output stays aligned with other editor actions.
 */
public class CopySelectionReferenceAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(CopySelectionReferenceAction.class);

    private static Consumer<String> clipboardWriter = CopySelectionReferenceAction::writeToClipboard;

    private final SelectionReferenceBuilder selectionReferenceBuilder;

    public CopySelectionReferenceAction() {
        this(
                new SelectionReferenceBuilder(),
                ClaudeCodeGuiBundle.message("action.copyAiReference.text"),
                ClaudeCodeGuiBundle.message("action.copyAiReference.description")
        );
    }

    CopySelectionReferenceAction(@NotNull SelectionReferenceBuilder selectionReferenceBuilder) {
        this(
                selectionReferenceBuilder,
                "Copy AI Reference",
                "Copy the selected code location as an AI reference"
        );
    }

    CopySelectionReferenceAction(@NotNull SelectionReferenceBuilder selectionReferenceBuilder,
                                 @NotNull String text,
                                 @NotNull String description) {
        super(text, description, null);
        this.selectionReferenceBuilder = Objects.requireNonNull(selectionReferenceBuilder);
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        try {
            ReadAction
                    .nonBlocking(() -> buildSelectionReference(e))
                    .finishOnUiThread(
                            ModalityState.defaultModalityState(),
                            result -> handleBuildResult(project, result)
                    )
                    .submit(AppExecutorUtil.getAppExecutorService());
        } catch (RuntimeException ex) {
            showError(project, ClaudeCodeGuiBundle.message("send.failed", ex.getMessage()));
            LOG.error("Failed to copy selection reference", ex);
        }
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Editor editor = e.getData(CommonDataKeys.EDITOR);
        if (editor == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();
        boolean hasSelection = selectedText != null && !selectedText.trim().isEmpty();
        e.getPresentation().setEnabledAndVisible(hasSelection);
    }

    @NotNull SelectionReferenceBuilder.Result buildSelectionReference(@NotNull AnActionEvent e) {
        VirtualFile virtualFile = e.getData(CommonDataKeys.VIRTUAL_FILE);
        return selectionReferenceBuilder.build(e.getData(CommonDataKeys.EDITOR), virtualFile);
    }

    void handleBuildResult(@Nullable Project project, @NotNull SelectionReferenceBuilder.Result result) {
        if (!result.isSuccess()) {
            SelectionReferenceFailureHandler.showBuildFailure(
                    result,
                    message -> showInfo(project, message),
                    message -> showError(project, message)
            );
            return;
        }

        try {
            clipboardWriter.accept(result.getReference());
        } catch (RuntimeException ex) {
            LOG.warn("Failed to write selection reference to clipboard", ex);
            showClipboardWriteFailure(project, ClaudeCodeGuiBundle.message("action.copyAiReference.copyFailed"));
        }
    }

    static void setClipboardWriterForTest(Consumer<String> writer) {
        clipboardWriter = Objects.requireNonNull(writer);
    }

    static void resetClipboardWriter() {
        clipboardWriter = CopySelectionReferenceAction::writeToClipboard;
    }

    private static void writeToClipboard(@NotNull String content) {
        Toolkit.getDefaultToolkit().getSystemClipboard().setContents(new StringSelection(content), null);
    }

    private void showClipboardWriteFailure(@Nullable Project project, @NotNull String message) {
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() ->
                    com.intellij.openapi.ui.Messages.showErrorDialog(
                            project,
                            message,
                            ClaudeCodeGuiBundle.message("dialog.error.title")
                    )
            );
        }
    }

    private void showError(@Nullable Project project, @NotNull String message) {
        LOG.error(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() ->
                    com.intellij.openapi.ui.Messages.showErrorDialog(
                            project,
                            message,
                            ClaudeCodeGuiBundle.message("dialog.error.title")
                    )
            );
        }
    }

    private void showInfo(@Nullable Project project, @NotNull String message) {
        LOG.info(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() ->
                    com.intellij.openapi.ui.Messages.showInfoMessage(
                            project,
                            message,
                            ClaudeCodeGuiBundle.message("dialog.info.title")
                    )
            );
        }
    }
}
