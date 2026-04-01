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
 */
public class SettingsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SettingsHandler.class);

    private final InputHistoryHandler inputHistoryHandler;
    private final SoundSettingsHandler soundSettingsHandler;
    private final UsagePushService usagePushService;
    private final PermissionModeHandler permissionModeHandler;
    private final ModelProviderHandler modelProviderHandler;
    private final NodePathHandler nodePathHandler;
    private final ProjectConfigHandler projectConfigHandler;

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
        "get_ide_theme",
        "get_commit_prompt",
        "set_commit_prompt",
        "get_input_history",
        "record_input_history",
        "delete_input_history_item",
        "clear_input_history",
        // Sound notification configuration
        "get_sound_notification_config",
        "set_sound_notification_enabled",
        "set_sound_only_when_unfocused",
        "set_selected_sound",
        "set_custom_sound_path",
        "test_sound",
        "browse_sound_file"
    };

    public SettingsHandler(HandlerContext context) {
        super(context);
        this.inputHistoryHandler = new InputHistoryHandler(context);
        this.soundSettingsHandler = new SoundSettingsHandler(context);
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
     */
    private void registerThemeChangeListener() {
        ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onIdeThemeChanged", escapeJs(themeConfig.toString()));
            });
        });
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

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
            case "get_ide_theme":
                projectConfigHandler.handleGetIdeTheme();
                return true;
            case "get_commit_prompt":
                projectConfigHandler.handleGetCommitPrompt();
                return true;
            case "set_commit_prompt":
                projectConfigHandler.handleSetCommitPrompt(content);
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
            // Sound notification configuration
            case "get_sound_notification_config":
                soundSettingsHandler.handleGetSoundNotificationConfig();
                return true;
            case "set_sound_notification_enabled":
                soundSettingsHandler.handleSetSoundNotificationEnabled(content);
                return true;
            case "set_sound_only_when_unfocused":
                soundSettingsHandler.handleSetSoundOnlyWhenUnfocused(content);
                return true;
            case "set_selected_sound":
                soundSettingsHandler.handleSetSelectedSound(content);
                return true;
            case "set_custom_sound_path":
                soundSettingsHandler.handleSetCustomSoundPath(content);
                return true;
            case "test_sound":
                soundSettingsHandler.handleTestSound(content);
                return true;
            case "browse_sound_file":
                soundSettingsHandler.handleBrowseSoundFile();
                return true;
            default:
                return false;
        }
    }

    /**
     * Expose getModelContextLimit for callers that previously used the static method on SettingsHandler.
     */
    public static int getModelContextLimit(String model) {
        return ModelProviderHandler.getModelContextLimit(model);
    }
}
