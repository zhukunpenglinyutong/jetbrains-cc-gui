package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileChooser.FileChooser;
import com.intellij.openapi.fileChooser.FileChooserDescriptor;
import com.intellij.openapi.vfs.VirtualFile;

/**
 * Handles task completion sound notification settings.
 */
public class SoundSettingsHandler {
    private static final Logger LOG = Logger.getInstance(SoundSettingsHandler.class);

    private final HandlerContext context;
    private final CodemossSettingsService settingsService;
    private final Gson gson = new Gson();

    public SoundSettingsHandler(HandlerContext context) {
        this.context = context;
        this.settingsService = context.getSettingsService();
    }

    public void handleGetSoundNotificationConfig() {
        try {
            pushSoundConfig();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to get sound notification config: " + e.getMessage(), e);
            showError("Failed to get sound notification config: " + e.getMessage());
        }
    }

    public void handleSetSoundNotificationEnabled(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json != null && json.has("enabled") && json.get("enabled").getAsBoolean();
            settingsService.setSoundNotificationEnabled(enabled);
            pushSoundConfig();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set sound notification enabled: " + e.getMessage(), e);
            showError("Failed to save sound notification setting: " + e.getMessage());
        }
    }

    public void handleSetSoundOnlyWhenUnfocused(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean enabled = json != null && json.has("enabled") && json.get("enabled").getAsBoolean();
            settingsService.setSoundOnlyWhenUnfocused(enabled);
            pushSoundConfig();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set sound focus mode: " + e.getMessage(), e);
            showError("Failed to save sound focus mode: " + e.getMessage());
        }
    }

    public void handleSetSelectedSound(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String soundId = readString(json, "soundId", "default");
            settingsService.setSelectedSound(soundId);
            pushSoundConfig();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set selected sound: " + e.getMessage(), e);
            showError("Failed to save selected sound: " + e.getMessage());
        }
    }

    public void handleSetCustomSoundPath(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String path = readString(json, "path", "");
            settingsService.setCustomSoundPath(path);
            pushSoundConfig();
            showSuccessI18n("settings.basic.soundNotification.customSoundSaved");
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to set custom sound path: " + e.getMessage(), e);
            showError("Failed to save custom sound path: " + e.getMessage());
        }
    }

    public void handleTestSound(String content) {
        showSuccess("Sound settings are available. Audio preview is not implemented in this handler.");
    }

    public void handleBrowseSoundFile() {
        FileChooserDescriptor descriptor = new FileChooserDescriptor(true, false, false, false, false, false)
                .withTitle("Select Sound File")
                .withDescription("Choose a WAV, MP3, or AIFF sound file");
        FileChooser.chooseFile(descriptor, context.getProject(), null, this::handleSoundFileChosen);
    }

    private void handleSoundFileChosen(VirtualFile file) {
        if (file == null) {
            return;
        }
        try {
            settingsService.setCustomSoundPath(file.getPath());
            pushSoundConfig();
        } catch (Exception e) {
            LOG.error("[SoundSettingsHandler] Failed to save selected sound file: " + e.getMessage(), e);
            showError("Failed to save selected sound file: " + e.getMessage());
        }
    }

    private void pushSoundConfig() throws Exception {
        JsonObject response = new JsonObject();
        response.addProperty("enabled", settingsService.getSoundNotificationEnabled());
        response.addProperty("onlyWhenUnfocused", settingsService.getSoundOnlyWhenUnfocused());
        response.addProperty("selectedSound", settingsService.getSelectedSound());
        String customSoundPath = settingsService.getCustomSoundPath();
        response.addProperty("customSoundPath", customSoundPath != null ? customSoundPath : "");
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateSoundNotificationConfig", context.escapeJs(gson.toJson(response))));
    }

    private String readString(JsonObject json, String field, String defaultValue) {
        if (json == null || !json.has(field) || json.get(field).isJsonNull()) {
            return defaultValue;
        }
        String value = json.get(field).getAsString();
        return value != null ? value : defaultValue;
    }

    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(message)));
    }

    private void showSuccess(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showSuccess", context.escapeJs(message)));
    }

    private void showSuccessI18n(String key) {
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showSuccessI18n", context.escapeJs(key)));
    }
}
