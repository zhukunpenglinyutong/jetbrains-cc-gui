package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import org.jetbrains.annotations.NotNull;

import javax.swing.Timer;
import java.awt.AWTEvent;
import java.awt.Toolkit;
import java.awt.event.AWTEventListener;
import java.awt.event.KeyEvent;
import java.awt.event.WindowEvent;
import java.util.function.Consumer;

/**
 * Push-to-talk shortcut for voice input, usable from anywhere in the IDE.
 *
 * <p>Registered in the keymap so it is discoverable and rebindable. Holding the shortcut
 * records until release; a short tap toggles. The webview decides which, from the
 * {@code down}/{@code up} timing this action forwards.
 */
public class VoiceInputAction extends AnAction implements DumbAware {

    public static final String ID = "ClaudeCodeGUI.VoiceInputAction";
    private static final String TOOL_WINDOW_ID = "CCG";
    /** X11 without detectable auto-repeat sends release+press pairs while held; wait this long before trusting a release. */
    private static final int RELEASE_GRACE_MS = 80;

    // Touched only on the EDT: action invocations, AWT listeners and Swing timers all run there.
    private final PushToTalkKeyState keyState = new PushToTalkKeyState();
    private ClaudeChatWindow target;
    private AWTEventListener keyListener;
    private Timer pendingRelease;

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setEnabled(e.getProject() != null);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }
        KeyEvent key = e.getInputEvent() instanceof KeyEvent k && k.getID() == KeyEvent.KEY_PRESSED ? k : null;
        if (key == null) {
            // Menu or Find Action: no key to hold, so this is a tap.
            stopWatching();
        } else if (!keyState.press(System.currentTimeMillis())) {
            // Auto-repeat of the held key; an X11 release+press pair also lands here.
            cancelPendingRelease();
            return;
        } else {
            unregisterListener();
        }

        withChatWindow(project, this::stopWatching, window -> {
            send(window, "down");
            if (key == null) {
                send(window, "up");
                return;
            }
            target = window;
            watchRelease(key.getKeyCode());
        });
    }

    /** Uses the selected chat tab, showing the panel first (without taking focus) when it is hidden. */
    private static void withChatWindow(Project project, Runnable onMissing, Consumer<ClaudeChatWindow> action) {
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID);
        if (toolWindow == null) {
            onMissing.run();
            return;
        }
        Runnable run = () -> {
            ClaudeChatWindow window = selectedChatWindow(project, toolWindow);
            if (window != null) {
                action.accept(window);
            } else {
                onMissing.run();
            }
        };
        if (toolWindow.isVisible()) {
            run.run();
        } else {
            toolWindow.show(run);
        }
    }

    private static ClaudeChatWindow selectedChatWindow(Project project, ToolWindow toolWindow) {
        Content selected = toolWindow.getContentManager().getSelectedContent();
        ClaudeChatWindow window = selected != null ? ClaudeSDKToolWindow.getChatWindowForContent(selected) : null;
        return window != null ? window : ClaudeSDKToolWindow.getChatWindow(project);
    }

    private void watchRelease(int keyCode) {
        keyListener = event -> {
            // Leaving the IDE while holding the key hides its key-up: treat that as the release.
            if (event instanceof WindowEvent windowEvent && windowEvent.getID() == WindowEvent.WINDOW_LOST_FOCUS
                    && windowEvent.getOppositeWindow() == null) {
                release();
                return;
            }
            if (!(event instanceof KeyEvent keyEvent) || keyEvent.getKeyCode() != keyCode) {
                return;
            }
            if (keyEvent.getID() == KeyEvent.KEY_PRESSED) {
                cancelPendingRelease();
            } else if (keyEvent.getID() == KeyEvent.KEY_RELEASED) {
                cancelPendingRelease();
                pendingRelease = new Timer(RELEASE_GRACE_MS, ignored -> release());
                pendingRelease.setRepeats(false);
                pendingRelease.start();
            }
        };
        Toolkit.getDefaultToolkit().addAWTEventListener(keyListener,
                AWTEvent.KEY_EVENT_MASK | AWTEvent.WINDOW_FOCUS_EVENT_MASK);
    }

    private void release() {
        ClaudeChatWindow window = target;
        stopWatching();
        if (window != null) {
            send(window, "up");
        }
    }

    private void stopWatching() {
        unregisterListener();
        keyState.release();
        // Do not keep a closed project's chat window reachable from this application-wide action.
        target = null;
    }

    private void unregisterListener() {
        cancelPendingRelease();
        if (keyListener != null) {
            Toolkit.getDefaultToolkit().removeAWTEventListener(keyListener);
            keyListener = null;
        }
    }

    private void cancelPendingRelease() {
        if (pendingRelease != null) {
            pendingRelease.stop();
            pendingRelease = null;
        }
    }

    private static void send(ClaudeChatWindow window, String phase) {
        window.executeJavaScriptCode("if (window.voiceInputShortcut) window.voiceInputShortcut('" + phase + "')");
    }
}
