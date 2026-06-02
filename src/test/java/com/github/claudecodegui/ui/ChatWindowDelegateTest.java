package com.github.claudecodegui.ui;

import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.core.MessageDispatcher;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.project.Project;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefBrowser;
import org.junit.Test;

import javax.swing.JPanel;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class ChatWindowDelegateTest {

    @Test
    public void replayPendingForkTitleIfReadySeedsTitleAfterSessionId() {
        RecordingHost host = new RecordingHost();
        host.frontendReady = true;
        host.session.setSessionInfo("source-session", System.getProperty("user.dir"));
        host.pendingForkTitle = "Source title[fork]";
        ChatWindowDelegate delegate = new ChatWindowDelegate(host);

        delegate.replayPendingForkTitleIfReady();

        assertEquals("setSessionId:source-session", host.calls.get(0));
        assertEquals("seedForkSessionTitle:Source title[fork]", host.calls.get(1));
        assertEquals(2, host.calls.size());
        assertEquals(null, host.pendingForkTitle);
    }

    @Test
    public void replayPendingForkTitleIfReadySkipsWhenFrontendIsNotReady() {
        RecordingHost host = new RecordingHost();
        host.frontendReady = false;
        host.session.setSessionInfo("source-session", System.getProperty("user.dir"));
        host.pendingForkTitle = "Source title[fork]";
        ChatWindowDelegate delegate = new ChatWindowDelegate(host);

        delegate.replayPendingForkTitleIfReady();

        assertEquals(0, host.calls.size());
        assertEquals("Source title[fork]", host.pendingForkTitle);
    }

    private static class RecordingHost implements ChatWindowDelegate.DelegateHost {
        private final ClaudeSession session = new ClaudeSession(null, null, null);
        private final JPanel mainPanel = new JPanel();
        private final List<String> calls = new ArrayList<>();
        private boolean frontendReady;
        private String pendingForkTitle;

        @Override public Project getProject() { return null; }
        @Override public ClaudeSDKBridge getClaudeSDKBridge() { return null; }
        @Override public CodexSDKBridge getCodexSDKBridge() { return null; }
        @Override public ClaudeSession getSession() { return session; }
        @Override public CodemossSettingsService getSettingsService() { return null; }
        @Override public JPanel getMainPanel() { return mainPanel; }
        @Override public JBCefBrowser getBrowser() { return null; }
        @Override public boolean isDisposed() { return false; }
        @Override public void callJavaScript(String fn, String... args) { calls.add(fn + ":" + (args.length > 0 ? args[0] : "")); }
        @Override public Content getParentContent() { return null; }
        @Override public String getOriginalTabName() { return null; }
        @Override public void setOriginalTabName(String name) { }
        @Override public String getSessionId() { return session.getSessionId(); }
        @Override public HandlerContext getHandlerContext() { return null; }
        @Override public void setHandlerContext(HandlerContext ctx) { }
        @Override public void setMessageDispatcher(MessageDispatcher d) { }
        @Override public void setPermissionHandler(PermissionHandler h) { }
        @Override public void setHistoryHandler(com.github.claudecodegui.handler.history.HistoryHandler h) { }
        @Override public SessionLifecycleManager getSessionLifecycleManager() { return null; }
        @Override public StreamMessageCoalescer getStreamCoalescer() { return null; }
        @Override public WebviewWatchdog getWebviewWatchdog() { return null; }
        @Override public PermissionHandler getPermissionHandler() { return null; }
        @Override public void interruptDueToPermissionDenial() { }
        @Override public boolean isFrontendReady() { return frontendReady; }
        @Override public void setFrontendReady(boolean ready) { frontendReady = ready; }
        @Override public void setSlashCommandsFetched(boolean fetched) { }
        @Override public void setFetchedSlashCommandsCount(int count) { }
        @Override public void persistTabSessionState() { }
        @Override public String popPendingForkTitle() {
            String value = pendingForkTitle;
            pendingForkTitle = null;
            return value;
        }
    }
}
