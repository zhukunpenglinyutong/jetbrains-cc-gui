package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.github.claudecodegui.util.SelectionTextUtils;
import org.jetbrains.annotations.NotNull;

/**
 * Action to send file paths from the project tree to the CCG input box.
 * Shown in the project file tree context menu.
 * Implements DumbAware to allow usage during index building.
 */
public class SendFilePathToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendFilePathToInputAction.class);

    /**
     * Constructor - sets localized action text and description.
     */
    public SendFilePathToInputAction() {
        super(
            ClaudeCodeGuiBundle.message("action.sendFilePath.text"),
            ClaudeCodeGuiBundle.message("action.sendFilePath.description"),
            null
        );
    }

    /**
     * Use background thread for action updates.
     * This allows safe access to VirtualFile data in the update() method.
     */
    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    /**
     * Main action execution logic.
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        // Get selected files
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file != null) {
                files = new VirtualFile[]{file};
            }
        }

        if (files == null || files.length == 0) {
            LOG.warn("No files selected");
            return;
        }

        // Build file path string (supports multi-selection)
        StringBuilder pathBuilder = new StringBuilder();
        for (int i = 0; i < files.length; i++) {
            if (i > 0) {
                pathBuilder.append(" ");
            }
            // Add @ prefix with absolute path
            pathBuilder.append("@").append(files[i].getPath());
        }

        String filePaths = pathBuilder.toString();
        LOG.info("Sending file paths to input: " + filePaths);

        // Send to chat window
        sendToChatWindow(project, filePaths);
    }

    /**
     * Update action availability.
     * Only enabled when files are selected.
     */
    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        // Check if any files are selected
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file == null) {
                e.getPresentation().setEnabledAndVisible(false);
                return;
            }
        }

        e.getPresentation().setEnabledAndVisible(true);
    }

    /**
     * Send file paths to the plugin's chat input box.
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String filePaths) {
        SelectionTextUtils.sendToChatWindow(project, filePaths, "file path");
    }
}
