package com.github.claudecodegui.startup;

import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.keymap.Keymap;
import com.intellij.openapi.keymap.KeymapManager;
import com.intellij.openapi.actionSystem.KeyboardShortcut;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.intellij.openapi.startup.ProjectActivity;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ide.DataManager;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.KeyStroke;
import java.awt.Component;
import java.awt.KeyboardFocusManager;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Keeps Ctrl+Z inside the CC GUI webview.
 *
 * The JCEF window is hosted in a tool window and, while the chat input has
 * focus, IDEA's global {@code $Undo} action can still win the key. When that
 * happens Ctrl+Z reverts the last editor change instead of the chat draft.
 *
 * The scoped {@code ChatUndoAction}/{@code ChatRedoAction} entries are not
 * enough on their own: keymap lookup may pick the built-in action first. This
 * guard removes the built-in Ctrl+Z / Ctrl+Shift+Z bindings while focus is in
 * the chat tool window and restores them the moment focus returns to an
 * editor or another tool window. The change is in-memory only; IDEA restores
 * the keymap on restart.
 */
public class ChatUndoShortcutGuard implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(ChatUndoShortcutGuard.class);
    private static final String CCG_TOOL_WINDOW_ID = "CCG";
    private static final String UNDO_ACTION_ID = "$Undo";
    private static final String REDO_ACTION_ID = "$Redo";

    private static final KeyStroke UNDO_KEY = SystemInfo.isMac
            ? KeyStroke.getKeyStroke("meta Z")
            : KeyStroke.getKeyStroke("control Z");
    private static final KeyStroke REDO_KEY = SystemInfo.isMac
            ? KeyStroke.getKeyStroke("meta shift Z")
            : KeyStroke.getKeyStroke("control shift Z");

    private static final AtomicBoolean INSTALLED = new AtomicBoolean(false);
    private static boolean undoRemoved;
    private static boolean redoRemoved;

    @Nullable
    @Override
    public Object execute(@Nullable Project project, @NotNull Continuation<? super Unit> continuation) {
        if (INSTALLED.compareAndSet(false, true)) {
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    KeyboardFocusManager.getCurrentKeyboardFocusManager()
                            .addPropertyChangeListener("focusOwner", event -> updateShortcuts("focusOwner"));
                    updateShortcuts("startup");
                } catch (Throwable t) {
                    LOG.warn("[ccgui-undo-guard] install failed", t);
                }
            });
        }
        return Unit.INSTANCE;
    }

    private static synchronized void updateShortcuts(String reason) {
        try {
            KeymapManager manager = KeymapManager.getInstance();
            Keymap keymap = manager == null ? null : manager.getActiveKeymap();
            if (keymap == null) {
                return;
            }

            boolean chatFocused = isChatFocused();
            if (chatFocused && !undoRemoved) {
                keymap.removeShortcut(UNDO_ACTION_ID, new KeyboardShortcut(UNDO_KEY, null));
                undoRemoved = true;
                LOG.info("[ccgui-undo-guard] removed $Undo " + UNDO_KEY + " (reason=" + reason + ")");
            } else if (!chatFocused && undoRemoved) {
                keymap.addShortcut(UNDO_ACTION_ID, new KeyboardShortcut(UNDO_KEY, null));
                undoRemoved = false;
                LOG.info("[ccgui-undo-guard] restored $Undo " + UNDO_KEY + " (reason=" + reason + ")");
            }

            if (chatFocused && !redoRemoved) {
                keymap.removeShortcut(REDO_ACTION_ID, new KeyboardShortcut(REDO_KEY, null));
                redoRemoved = true;
                LOG.info("[ccgui-undo-guard] removed $Redo " + REDO_KEY + " (reason=" + reason + ")");
            } else if (!chatFocused && redoRemoved) {
                keymap.addShortcut(REDO_ACTION_ID, new KeyboardShortcut(REDO_KEY, null));
                redoRemoved = false;
                LOG.info("[ccgui-undo-guard] restored $Redo " + REDO_KEY + " (reason=" + reason + ")");
            }
        } catch (Throwable t) {
            LOG.warn("[ccgui-undo-guard] update failed", t);
        }
    }

    /**
     * True when the focused component is not an editor and the CCG tool
     * window is the active one. When the focus owner is unknown (JCEF native
     * windows may not expose a Swing focus owner) the active tool window is
     * used as the deciding signal.
     */
    private static boolean isChatFocused() {
        Component owner = KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner();
        if (owner != null) {
            try {
                Editor editor = DataManager.getInstance().getDataContext(owner).getData(CommonDataKeys.EDITOR);
                if (editor != null) {
                    return false;
                }
            } catch (Throwable ignored) {
                // Fall through to the tool window check.
            }
        }

        for (Project project : ProjectManager.getInstance().getOpenProjects()) {
            ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow(CCG_TOOL_WINDOW_ID);
            if (toolWindow != null && toolWindow.isActive()) {
                return true;
            }
        }
        return false;
    }
}
