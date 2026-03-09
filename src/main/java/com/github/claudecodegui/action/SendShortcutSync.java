package com.github.claudecodegui.action;

import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.actionSystem.Shortcut;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.keymap.Keymap;
import com.intellij.openapi.keymap.KeymapManager;
import com.intellij.openapi.util.SystemInfo;

import javax.swing.*;

/**
 * Utility to sync ChatSendAction and ChatNewlineAction keyboard shortcuts
 * with the user's sendShortcut setting.
 *
 * <ul>
 *   <li>"enter" mode: Enter sends (WebView native), Ctrl+Enter → newline</li>
 *   <li>"cmdEnter" mode: Ctrl+Enter → send, Enter → newline (WebView native)</li>
 * </ul>
 *
 * Shortcuts are managed at runtime only (not persisted to keymap files).
 * They are re-applied on each plugin initialization via {@link #syncFromSettings()}.
 */
public final class SendShortcutSync {

    private static final Logger LOG = Logger.getInstance(SendShortcutSync.class);
    private static final String SEND_SHORTCUT_PROPERTY_KEY = "claude.code.send.shortcut";

    private SendShortcutSync() {}

    /**
     * Read the current sendShortcut setting and sync IDEA keymap accordingly.
     * Should be called once during plugin initialization.
     */
    public static void syncFromSettings() {
        String mode = PropertiesComponent.getInstance().getValue(SEND_SHORTCUT_PROPERTY_KEY, "enter");
        sync(mode);
    }

    /**
     * Update the IDEA keymap for ChatSendAction and ChatNewlineAction based on the sendShortcut mode.
     *
     * @param mode "cmdEnter" → Ctrl+Enter sends, "enter" → Ctrl+Enter inserts newline
     */
    private static final String MODE_ENTER = "enter";
    private static final String MODE_CMD_ENTER = "cmdEnter";

    public static void sync(String mode) {
        try {
            // Validate mode input
            if (mode == null || (!MODE_ENTER.equals(mode) && !MODE_CMD_ENTER.equals(mode))) {
                LOG.warn("Invalid sendShortcut mode: " + mode + ", defaulting to '" + MODE_ENTER + "'");
                mode = MODE_ENTER;
            }

            KeymapManager manager = KeymapManager.getInstance();
            if (manager == null) {
                LOG.warn("KeymapManager not available");
                return;
            }
            Keymap keymap = manager.getActiveKeymap();

            // Clear existing Ctrl+Enter shortcuts for both actions
            clearShortcuts(keymap, ChatSendAction.ACTION_ID);
            clearShortcuts(keymap, ChatNewlineAction.ACTION_ID);

            // Ctrl+Enter on Windows/Linux, Cmd+Enter on Mac
            KeyStroke ctrlEnter = SystemInfo.isMac
                ? KeyStroke.getKeyStroke("meta ENTER")
                : KeyStroke.getKeyStroke("ctrl ENTER");
            KeyboardShortcut shortcut = new KeyboardShortcut(ctrlEnter, null);

            if (MODE_CMD_ENTER.equals(mode)) {
                keymap.addShortcut(ChatSendAction.ACTION_ID, shortcut);
                LOG.info("Synced shortcuts: Ctrl+Enter → Send");
            } else {
                keymap.addShortcut(ChatNewlineAction.ACTION_ID, shortcut);
                LOG.info("Synced shortcuts: Ctrl+Enter → Newline");
            }
        } catch (Exception e) {
            LOG.warn("Failed to sync send shortcut keymap: " + e.getMessage(), e);
        }
    }

    private static void clearShortcuts(Keymap keymap, String actionId) {
        for (Shortcut sc : keymap.getShortcuts(actionId)) {
            keymap.removeShortcut(actionId, sc);
        }
    }
}
