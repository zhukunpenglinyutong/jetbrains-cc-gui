package com.github.claudecodegui;

import com.github.claudecodegui.util.SelectionTextUtils;
import com.intellij.execution.impl.ConsoleViewImpl;
import com.intellij.execution.ui.ConsoleView;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.LangDataKeys;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Sends selected Run/Debug console text to the CCG input box.
 */
public class SendConsoleSelectionToInputAction extends AnAction implements DumbAware {

    public SendConsoleSelectionToInputAction() {
        super(
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.text"),
                ClaudeCodeGuiBundle.message("action.sendConsoleSelection.description"),
                null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        String selectedText = getSelectedConsoleText(e);
        if (project == null || selectedText == null) {
            return;
        }
        SelectionTextUtils.sendToChatWindow(project, selectedText, "console");
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        e.getPresentation().setEnabledAndVisible(project != null && getSelectedConsoleText(e) != null);
    }

    private @Nullable String getSelectedConsoleText(@NotNull AnActionEvent e) {
        ConsoleView consoleView = e.getData(LangDataKeys.CONSOLE_VIEW);
        if (!(consoleView instanceof ConsoleViewImpl consoleViewImpl)) {
            return null;
        }

        Editor editor = consoleViewImpl.getEditor();
        if (editor == null) {
            return null;
        }
        return SelectionTextUtils.normalizeSendableText(editor.getSelectionModel().getSelectedText());
    }
}
