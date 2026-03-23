package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Handles provider import/export operations: preview, file selection, and saving imported results.
 */
public class ProviderImportExportSupport {

    private static final Logger LOG = Logger.getInstance(ProviderImportExportSupport.class);
    private static final Gson GSON = new Gson();

    private final HandlerContext context;
    private final ClaudeProviderOperations claudeOps;

    public ProviderImportExportSupport(HandlerContext context, ClaudeProviderOperations claudeOps) {
        this.context = context;
        this.claudeOps = claudeOps;
    }

    /**
     * Preview cc-switch import.
     */
    public void handlePreviewCcSwitchImport() {
        ApplicationManager.getApplication().invokeLater(() -> {
            String userHome = PlatformUtils.getHomeDirectory();
            String osName = System.getProperty("os.name").toLowerCase();

            File ccSwitchDir = new File(userHome, ".cc-switch");
            File dbFile = new File(ccSwitchDir, "cc-switch.db");

            LOG.info("[ProviderHandler] OS: " + osName);
            LOG.info("[ProviderHandler] User home: " + userHome);
            LOG.info("[ProviderHandler] cc-switch dir: " + ccSwitchDir.getAbsolutePath());
            LOG.info("[ProviderHandler] Database file path: " + dbFile.getAbsolutePath());
            LOG.info("[ProviderHandler] Database file exists: " + dbFile.exists());

            if (!dbFile.exists()) {
                String errorMsg = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                LOG.error("[ProviderHandler] " + errorMsg);
                sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                return;
            }

            CompletableFuture.runAsync(() -> {
                try {
                    LOG.info("[ProviderHandler] Starting to read database file...");
                    List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                    if (providers.isEmpty()) {
                        LOG.info("[ProviderHandler] No Claude provider configs found in database");
                        sendInfoToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.noDataTitle"), com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.noData"));
                        return;
                    }

                    JsonArray providersArray = new JsonArray();
                    for (JsonObject p : providers) {
                        providersArray.add(p);
                    }

                    JsonObject response = new JsonObject();
                    response.add("providers", providersArray);

                    String jsonStr = GSON.toJson(response);
                    LOG.info("[ProviderHandler] Successfully read " + providers.size() + " provider configs");
                    context.callJavaScript("window.import_preview_result", context.escapeJs(jsonStr));

                } catch (Exception e) {
                    String errorDetails = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailed") + ": " + e.getMessage();
                    LOG.error("[ProviderHandler] " + errorDetails, e);
                    sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailedTitle"), errorDetails);
                }
            });
        });
    }

    /**
     * Open file chooser for cc-switch database file
     */
    public void handleOpenFileChooserForCcSwitch() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileChooserDescriptor descriptor = new FileChooserDescriptor(
                        true,   // chooseFiles
                        false,  // chooseFolders
                        false,  // chooseJars
                        false,  // chooseJarsAsFiles
                        false,  // chooseJarContents
                        false   // chooseMultiple
                );

                descriptor.setTitle(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.selectTitle"));
                descriptor.setDescription(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.selectDesc"));
                descriptor.withFileFilter(file -> {
                    String name = file.getName().toLowerCase();
                    return name.endsWith(".db");
                });

                // Set default path to .cc-switch under user home directory
                String userHome = PlatformUtils.getHomeDirectory();
                File defaultDir = new File(userHome, ".cc-switch");
                VirtualFile defaultVirtualFile = null;
                if (defaultDir.exists()) {
                    defaultVirtualFile = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                                                 .findFileByPath(defaultDir.getAbsolutePath());
                }

                LOG.info("[ProviderHandler] Opening file chooser, default dir: " +
                                 (defaultVirtualFile != null ? defaultVirtualFile.getPath() : "user home"));

                // Open file chooser
                VirtualFile[] selectedFiles = FileChooser.chooseFiles(
                        descriptor,
                        context.getProject(),
                        defaultVirtualFile
                );

                if (selectedFiles.length == 0) {
                    LOG.info("[ProviderHandler] User cancelled file selection");
                    sendInfoToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.cancelledTitle"), com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.cancelled"));
                    return;
                }

                VirtualFile selectedFile = selectedFiles[0];
                String dbPath = selectedFile.getPath();
                File dbFile = new File(dbPath);

                LOG.info("[ProviderHandler] User selected database file path: " + dbFile.getAbsolutePath());
                LOG.info("[ProviderHandler] Database file exists: " + dbFile.exists());

                if (!dbFile.exists()) {
                    String errorMsg = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.notFound", dbFile.getAbsolutePath());
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.notFoundTitle"), errorMsg);
                    return;
                }

                if (!dbFile.canRead()) {
                    String errorMsg = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.cannotReadFile") + "\n" +
                                              dbFile.getAbsolutePath() + "\n" +
                                              com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.checkFilePermissions");
                    LOG.error("[ProviderHandler] " + errorMsg);
                    sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.permissionErrorTitle"), errorMsg);
                    return;
                }

                // Read database asynchronously
                CompletableFuture.runAsync(() -> {
                    try {
                        LOG.info("[ProviderHandler] Starting to read user-selected database file...");
                        List<JsonObject> providers = context.getSettingsService().parseProvidersFromCcSwitchDb(dbFile.getPath());

                        if (providers.isEmpty()) {
                            LOG.info("[ProviderHandler] No Claude provider configs found in database");
                            sendInfoToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.noDataTitle"), com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.noData"));
                            return;
                        }

                        JsonArray providersArray = new JsonArray();
                        for (JsonObject p : providers) {
                            providersArray.add(p);
                        }

                        JsonObject response = new JsonObject();
                        response.add("providers", providersArray);

                        String jsonStr = GSON.toJson(response);
                        LOG.info("[ProviderHandler] Successfully read " + providers.size() + " provider configs, sending to frontend");
                        context.callJavaScript("window.import_preview_result", context.escapeJs(jsonStr));

                    } catch (Exception e) {
                        String errorDetails = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailed") + ": " + e.getMessage();
                        LOG.error("[ProviderHandler] " + errorDetails, e);
                        sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.readFailedTitle"), errorDetails);
                    }
                });

            } catch (Exception e) {
                String errorDetails = com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.fileChooserFailed") + ": " + e.getMessage();
                LOG.error("[ProviderHandler] " + errorDetails, e);
                sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.fileChooserFailedTitle"), errorDetails);
            }
        });
    }

    /**
     * Save imported providers.
     */
    public void handleSaveImportedProviders(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject request = GSON.fromJson(content, JsonObject.class);
                JsonArray providersArray = request.getAsJsonArray("providers");

                if (providersArray == null || providersArray.isEmpty()) {
                    return;
                }

                List<JsonObject> providers = new ArrayList<>();
                for (JsonElement e : providersArray) {
                    if (e.isJsonObject()) {
                        providers.add(e.getAsJsonObject());
                    }
                }

                int count = context.getSettingsService().saveProviders(providers);

                ApplicationManager.getApplication().invokeLater(() -> {
                    claudeOps.handleGetProviders(); // Refresh UI
                    sendInfoToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.importSuccessTitle"), com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.importSuccess", count));
                });

            } catch (Exception e) {
                LOG.error("Failed to save imported providers", e);
                sendErrorToFrontend(com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("provider.ccswitch.saveFailedTitle"), e.getMessage());
            }
        });
    }

    /**
     * Send info notification to the frontend.
     */
    public void sendInfoToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        context.callJavaScript("backend_notification", "info", context.escapeJs(title), context.escapeJs(message));
    }

    /**
     * Send error notification to the frontend.
     */
    public void sendErrorToFrontend(String title, String message) {
        // Use multi-parameter passing to avoid JSON nested parsing issues
        context.callJavaScript("backend_notification", "error", context.escapeJs(title), context.escapeJs(message));
    }
}
