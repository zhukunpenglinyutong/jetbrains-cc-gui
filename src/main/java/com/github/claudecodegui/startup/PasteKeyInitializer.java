package com.github.claudecodegui.startup;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import com.intellij.ui.jcef.JBCefBrowser;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Registers the CEF-level paste hook on first project open.
 *
 * Why: on macOS 27+, when the JCEF webview (OSR mode) has focus, the Cmd+V
 * KEYEVENT_RAWKEYDOWN is swallowed by the OS before reaching CEF; only an
 * orphaned KEYEVENT_KEYUP arrives. IDE-level actions and AWT listeners never
 * see the event either. CefPasteHook attaches to the CefClient keyboard
 * handler chain (the same native path the webview receives events through)
 * and detects the orphaned Cmd+V KEYUP to paste clipboard images.
 */
public class PasteKeyInitializer implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(PasteKeyInitializer.class);
    private static final AtomicBoolean CEF_INSTALLED = new AtomicBoolean(false);

    @Nullable
    @Override
    public Object execute(@Nullable Project project, @NotNull Continuation<? super Unit> continuation) {
        try {
            // Delay to let toolwindow + browser initialize
            com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                try {
                    installCefHook(project, 0);
                } catch (Throwable t) {
                    LOG.warn("[paste-fix] deferred CEF install failed", t);
                }
            }, 15, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Throwable t) {
            LOG.warn("[paste-fix] PasteKeyInitializer failed", t);
        }
        return Unit.INSTANCE;
    }

    private static void installCefHook(Project project, int attempt) {
        if (CEF_INSTALLED.get()) {
            return;
        }
        if (attempt > 12) {
            LOG.warn("[paste-fix][CEF] giving up after 12 attempts");
            return;
        }
        try {
            ClaudeChatWindow window = ClaudeSDKToolWindow.getChatWindow(project);
            if (window == null) {
                retry(project, attempt);
                return;
            }
            JBCefBrowser browser = readBrowserField(window);
            if (browser == null) {
                retry(project, attempt);
                return;
            }
            org.cef.CefClient client = browser.getCefBrowser().getClient();
            if (client == null) {
                retry(project, attempt);
                return;
            }
            if (CEF_INSTALLED.compareAndSet(false, true)) {
                CefPasteHook.install(client, window);
                LOG.info("[paste-fix][CEF] CefPasteHook installed (attempt=" + attempt + ")");
            }
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install error", t);
        }
    }

    private static void retry(Project project, int attempt) {
        com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule(
                () -> installCefHook(project, attempt + 1), 5, java.util.concurrent.TimeUnit.SECONDS);
    }

    private static JBCefBrowser readBrowserField(ClaudeChatWindow window) {
        try {
            Field f = ClaudeChatWindow.class.getDeclaredField("browser");
            f.setAccessible(true);
            Object v = f.get(window);
            return v instanceof JBCefBrowser ? (JBCefBrowser) v : null;
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] reflection failed", t);
            return null;
        }
    }
}
