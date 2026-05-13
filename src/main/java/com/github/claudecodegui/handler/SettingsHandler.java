package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.provider.ModelProviderHandler;

import com.github.claudecodegui.util.ThemeConfigService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Settings and usage statistics message handler.
 * Delegates to focused sub-handlers for each concern.
 *
 * @author melon
 */
public class SettingsHandler extends BaseMessageHandler {

    /**
     * log.
     */
    private static final Logger LOG = Logger.getInstance(SettingsHandler.class);

    /**
     * input history handler.
     */
    private final InputHistoryHandler inputHistoryHandler;
    /**
     * usage push service.
     */
    private final UsagePushService usagePushService;
    /**
     * permission mode handler.
     */
    private final PermissionModeHandler permissionModeHandler;
    /**
     * model provider handler.
     */
    private final ModelProviderHandler modelProviderHandler;
    /**
     * node path handler.
     */
    private final NodePathHandler nodePathHandler;
    /**
     * project config handler.
     */
    private final ProjectConfigHandler projectConfigHandler;

    /**
     * supported types.
     */
    private static final String[] SUPPORTED_TYPES = {
        "get_mode",
        "set_mode",
        "set_model",
        "set_provider",
        "set_reasoning_effort",
        "get_node_path",
        "set_node_path",
        "get_usage_statistics",
        "get_working_directory",
        "set_working_directory",
        "get_editor_font_config",
        "get_ui_font_config",
        "set_ui_font_config",
        "browse_ui_font_file",
        "get_streaming_enabled",
        "set_streaming_enabled",
        "get_codex_sandbox_mode",
        "set_codex_sandbox_mode",
        "get_send_shortcut",
        "set_send_shortcut",
        "get_auto_open_file_enabled",
        "set_auto_open_file_enabled",
        "get_commit_generation_enabled",
        "set_commit_generation_enabled",
        "get_status_bar_widget_enabled",
        "set_status_bar_widget_enabled",
        "get_task_completion_notification_enabled",
        "set_task_completion_notification_enabled",
        "get_ide_theme",
        "get_commit_prompt",
        "set_commit_prompt",
        "get_commit_ai_config",
        "set_commit_ai_config",
        "get_prompt_enhancer_config",
        "set_prompt_enhancer_config",
        "get_project_commit_prompt",
        "set_project_commit_prompt",
        "get_input_history",
        "record_input_history",
        "delete_input_history_item",
        "clear_input_history"
    };

    /**
     * Settings Handler
     *
     * @param context context
     */
    public SettingsHandler(HandlerContext context) {
        super(context);
        this.inputHistoryHandler = new InputHistoryHandler(context);
        this.usagePushService = new UsagePushService(context);
        this.permissionModeHandler = new PermissionModeHandler(context);
        this.modelProviderHandler = new ModelProviderHandler(context, usagePushService);
        this.nodePathHandler = new NodePathHandler(context);
        this.projectConfigHandler = new ProjectConfigHandler(context);
        // Register theme change listener to automatically notify frontend when IDE theme changes
        registerThemeChangeListener();
    }

    /**
     * Register theme change listener.
     *
     */
    private void registerThemeChangeListener() {
        ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onIdeThemeChanged", escapeJs(themeConfig.toString()));
            });
        });
    }

    /**
     * Get Supported Types
     *
     * @return string[]
     */
    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    /**
     * Handle
     *
     * @param type type
     * @param content content
     * @return boolean
     */
    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            // Permission mode
            case "get_mode":
                permissionModeHandler.handleGetMode();
                return true;
            case "set_mode":
                permissionModeHandler.handleSetMode(content);
                return true;
            // Model and provider
            case "set_model":
                modelProviderHandler.handleSetModel(content);
                return true;
            case "set_provider":
                modelProviderHandler.handleSetProvider(content);
                return true;
            case "set_reasoning_effort":
                modelProviderHandler.handleSetReasoningEffort(content);
                return true;
            // Node path
            case "get_node_path":
                nodePathHandler.handleGetNodePath();
                return true;
            case "set_node_path":
                nodePathHandler.handleSetNodePath(content);
                return true;
            // Project configuration
            case "get_usage_statistics":
                projectConfigHandler.handleGetUsageStatistics(content);
                return true;
            case "get_working_directory":
                projectConfigHandler.handleGetWorkingDirectory();
                return true;
            case "set_working_directory":
                projectConfigHandler.handleSetWorkingDirectory(content);
                return true;
            case "get_editor_font_config":
                projectConfigHandler.handleGetEditorFontConfig();
                return true;
            case "get_ui_font_config":
                projectConfigHandler.handleGetUiFontConfig();
                return true;
            case "set_ui_font_config":
                projectConfigHandler.handleSetUiFontConfig(content);
                return true;
            case "browse_ui_font_file":
                projectConfigHandler.handleBrowseUiFontFile();
                return true;
            case "get_streaming_enabled":
                projectConfigHandler.handleGetStreamingEnabled();
                return true;
            case "set_streaming_enabled":
                projectConfigHandler.handleSetStreamingEnabled(content);
                return true;
            case "get_codex_sandbox_mode":
                projectConfigHandler.handleGetCodexSandboxMode();
                return true;
            case "set_codex_sandbox_mode":
                projectConfigHandler.handleSetCodexSandboxMode(content);
                return true;
            case "get_send_shortcut":
                projectConfigHandler.handleGetSendShortcut();
                return true;
            case "set_send_shortcut":
                projectConfigHandler.handleSetSendShortcut(content);
                return true;
            case "get_auto_open_file_enabled":
                projectConfigHandler.handleGetAutoOpenFileEnabled();
                return true;
            case "set_auto_open_file_enabled":
                projectConfigHandler.handleSetAutoOpenFileEnabled(content);
                return true;
            case "get_commit_generation_enabled":
                projectConfigHandler.handleGetCommitGenerationEnabled();
                return true;
            case "set_commit_generation_enabled":
                projectConfigHandler.handleSetCommitGenerationEnabled(content);
                return true;
            case "get_status_bar_widget_enabled":
                projectConfigHandler.handleGetStatusBarWidgetEnabled();
                return true;
            case "set_status_bar_widget_enabled":
                projectConfigHandler.handleSetStatusBarWidgetEnabled(content);
                return true;
            case "get_task_completion_notification_enabled":
                projectConfigHandler.handleGetTaskCompletionNotificationEnabled();
                return true;
            case "set_task_completion_notification_enabled":
                projectConfigHandler.handleSetTaskCompletionNotificationEnabled(content);
                return true;
            case "get_ai_title_generation_enabled":
                projectConfigHandler.handleGetAiTitleGenerationEnabled();
                return true;
            case "set_ai_title_generation_enabled":
                projectConfigHandler.handleSetAiTitleGenerationEnabled(content);
                return true;
            case "get_ide_theme":
                projectConfigHandler.handleGetIdeTheme();
                return true;
            case "get_commit_prompt":
                projectConfigHandler.handleGetCommitPrompt();
                return true;
            case "set_commit_prompt":
                projectConfigHandler.handleSetCommitPrompt(content);
                return true;
            case "get_commit_ai_config":
                projectConfigHandler.handleGetCommitAiConfig();
                return true;
            case "set_commit_ai_config":
                projectConfigHandler.handleSetCommitAiConfig(content);
                return true;
            case "get_prompt_enhancer_config":
                projectConfigHandler.handleGetPromptEnhancerConfig();
                return true;
            case "set_prompt_enhancer_config":
                projectConfigHandler.handleSetPromptEnhancerConfig(content);
                return true;
            case "get_project_commit_prompt":
                projectConfigHandler.handleGetProjectCommitPrompt();
                return true;
            case "set_project_commit_prompt":
                projectConfigHandler.handleSetProjectCommitPrompt(content);
                return true;
            // Input history
            case "get_input_history":
                inputHistoryHandler.handleGetInputHistory();
                return true;
            case "record_input_history":
                inputHistoryHandler.handleRecordInputHistory(content);
                return true;
            case "delete_input_history_item":
                inputHistoryHandler.handleDeleteInputHistoryItem(content);
                return true;
            case "clear_input_history":
                inputHistoryHandler.handleClearInputHistory();
                return true;
            default:
                return false;
        }
    }

    /**
     * Expose getModelContextLimit for callers that previously used the static method on SettingsHandler.
     *
     * @param model model
     * @return int
     */
    public static int getModelContextLimit(String model) {
        return ModelProviderHandler.getModelContextLimit(model);
    }
}
