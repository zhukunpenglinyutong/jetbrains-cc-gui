package com.github.claudecodegui.terminal;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.util.SelectionTextUtils;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import org.jetbrains.plugins.terminal.block.util.TerminalDataContextUtils;

/**
 * Sends selected terminal text to the CCG input box.
 */
public class SendTerminalSelectionToInputAction extends AnAction implements DumbAware {

    public SendTerminalSelectionToInputAction() {
        super(
                ClaudeCodeGuiBundle.message("action.sendTerminalSelection.text"),
                ClaudeCodeGuiBundle.message("action.sendTerminalSelection.description"),
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
        String selectedText = getSelectedTerminalText(e);
        if (project == null || selectedText == null) {
            return;
        }
        SelectionTextUtils.sendToChatWindow(project, selectedText, "terminal");
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        e.getPresentation().setEnabledAndVisible(project != null && getSelectedTerminalText(e) != null);
    }

    private @Nullable String getSelectedTerminalText(@NotNull AnActionEvent e) {
        Editor editor = TerminalDataContextUtils.INSTANCE.getEditor(e);
        if (editor == null) {
            return null;
        }

        boolean supportedEditor = TerminalDataContextUtils.INSTANCE.isPromptEditor(editor)
                || TerminalDataContextUtils.INSTANCE.isOutputEditor(editor)
                || TerminalDataContextUtils.INSTANCE.isAlternateBufferEditor(editor);
        if (!supportedEditor) {
            return null;
        }

        return SelectionTextUtils.normalizeSendableText(editor.getSelectionModel().getSelectedText());
    }
}
