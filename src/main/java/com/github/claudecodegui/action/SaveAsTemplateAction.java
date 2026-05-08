package com.github.claudecodegui.action;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.SessionTemplateService;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

/**
 * Action to save the current session configuration as a reusable template.
 */
public class SaveAsTemplateAction extends ChatToolWindowAction {

    private static final Logger LOG = Logger.getInstance(SaveAsTemplateAction.class);

    public SaveAsTemplateAction() {
        super();
        getTemplatePresentation().setText(ClaudeCodeGuiBundle.message("action.saveAsTemplate.text"));
        getTemplatePresentation().setDescription(ClaudeCodeGuiBundle.message("action.saveAsTemplate.description"));
    }

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        ClaudeSession session = chatWindow.getSession();
        if (session == null) {
            Messages.showErrorDialog(
                project,
                ClaudeCodeGuiBundle.message("template.save.error.noSession"),
                ClaudeCodeGuiBundle.message("template.save.error.title")
            );
            return;
        }

        // Get template name from user
        String templateName = Messages.showInputDialog(
            project,
            ClaudeCodeGuiBundle.message("template.save.name.prompt"),
            ClaudeCodeGuiBundle.message("template.save.name.title"),
            Messages.getQuestionIcon(),
            "",
            null
        );

        if (templateName == null || templateName.trim().isEmpty()) {
            return; // User cancelled
        }

        templateName = templateName.trim();

        // Check if template already exists
        SessionTemplateService templateService = SessionTemplateService.getInstance();
        if (templateService.templateExists(templateName)) {
            int result = Messages.showYesNoDialog(
                project,
                ClaudeCodeGuiBundle.message("template.save.overwrite.prompt", templateName),
                ClaudeCodeGuiBundle.message("template.save.overwrite.title"),
                Messages.getQuestionIcon()
            );
            if (result != Messages.YES) {
                return; // User chose not to overwrite
            }
        }

        // Create template from current session state
        SessionTemplate template = new SessionTemplate(
            templateName,
            session.getProvider(),
            session.getModel(),
            session.getPermissionMode(),
            session.getReasoningEffort(),
            session.getCwd(),
            session.isPsiContextEnabled()
        );

        // Save template
        templateService.saveTemplate(template);

        Messages.showInfoMessage(
            project,
            ClaudeCodeGuiBundle.message("template.save.success", templateName),
            ClaudeCodeGuiBundle.message("template.save.success.title")
        );

        LOG.info("Saved session template: " + templateName);
    }
}