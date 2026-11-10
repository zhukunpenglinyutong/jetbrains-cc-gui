package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * The webview asks for the real loading state when a send it dispatched has
 * not streamed within its immunity window; the answer must reflect the session.
 */
public class SessionHandlerSyncLoadingStateTest {

    /** An idle session answers false so the webview can release a stuck queue. */
    @Test
    public void reportsIdleSession() {
        RecordingJsCallback js = new RecordingJsCallback();
        HandlerContext context = new HandlerContext(null, null, null, null, js);
        context.setSession(new ClaudeSession(null, null, null, null));

        assertTrue(new SessionHandler(context).handle("sync_loading_state", ""));
        assertEquals(List.of("showLoading:false"), js.calls);
    }

    /** A turn that is still running keeps the webview loading. */
    @Test
    public void reportsRunningTurn() {
        RecordingJsCallback js = new RecordingJsCallback();
        HandlerContext context = new HandlerContext(null, null, null, null, js);
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.getState().beginTurn();
        context.setSession(session);

        assertTrue(new SessionHandler(context).handle("sync_loading_state", ""));
        assertEquals(List.of("showLoading:true"), js.calls);
    }

    /** Without a session there is no state to report. */
    @Test
    public void staysSilentWithoutSession() {
        RecordingJsCallback js = new RecordingJsCallback();
        HandlerContext context = new HandlerContext(null, null, null, null, js);

        assertTrue(new SessionHandler(context).handle("sync_loading_state", ""));
        assertEquals(List.of(), js.calls);
    }

    /** Records JavaScript calls as "function:arg1,arg2". */
    private static final class RecordingJsCallback implements HandlerContext.JsCallback {
        private final List<String> calls = new ArrayList<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
            calls.add(functionName + ":" + String.join(",", args));
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }
}
