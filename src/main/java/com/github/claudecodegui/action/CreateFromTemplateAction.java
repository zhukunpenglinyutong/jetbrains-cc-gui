package com.github.claudecodegui.action;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.ui.TemplateSelectionDialog;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * Action to create a new session from a saved template.
 */
public class CreateFromTemplateAction extends ChatToolWindowAction {

    private static final Logger LOG = Logger.getInstance(CreateFromTemplateAction.class);

    public CreateFromTemplateAction() {
        super();
        getTemplatePresentation().setText(ClaudeCodeGuiBundle.message("action.createFromTemplate.text"));
        getTemplatePresentation().setDescription(ClaudeCodeGuiBundle.message("action.createFromTemplate.description"));
    }

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        // Show template selection dialog
        TemplateSelectionDialog dialog = new TemplateSelectionDialog();
        if (!dialog.showAndGet()) {
            return; // User cancelled
        }

        SessionTemplate selectedTemplate = dialog.getSelectedTemplate();
        if (selectedTemplate == null) {
            return; // No template selected
        }

        // Create new session from template in current window
        chatWindow.getSessionLifecycleManager().createNewSessionFromTemplate(selectedTemplate);

        LOG.info("[CreateFromTemplateAction] Created new session from template: " + selectedTemplate.name);
    }
}