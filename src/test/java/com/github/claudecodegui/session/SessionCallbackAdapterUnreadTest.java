package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;

public class SessionCallbackAdapterUnreadTest {
    private Application previousApplication;

    @Before
    public void isolateScheduledVfsRefreshes() {
        previousApplication = ApplicationManager.getApplication();
        ApplicationManager.setApplication((Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, args) ->
                        method.getReturnType() == boolean.class ? false : null));
    }

    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    private static final class Fixture implements AutoCloseable {
        final AtomicInteger completions = new AtomicInteger();
        final AtomicInteger starts = new AtomicInteger();
        final AtomicBoolean failNotification = new AtomicBoolean();
        final SessionExecutionState execution = new SessionExecutionState();
        final List<String> calls = new CopyOnWriteArrayList<>();
        final StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override public boolean callJavaScript(String name, String... args) { return true; }
            @Override public boolean isDisposed() { return false; }
            @Override public HandlerContext getHandlerContext() { return null; }
        });
        final SessionCallbackAdapter adapter = adapter();
        SessionCallbackAdapter adapter() {
            return new SessionCallbackAdapter(coalescer, new SessionCallbackAdapter.JsTarget() {
                @Override public void callJavaScript(String name, String... args) { calls.add(name); }
                @Override public SessionExecutionState.Snapshot getExecutionSnapshot() { return execution.snapshot(); }
                @Override public void onTurnStarted() { starts.incrementAndGet(); }
                @Override public void onTurnCompleted(SessionExecutionState.Snapshot completed) {
                    completions.incrementAndGet();
                    if (failNotification.get()) throw new IllegalStateException("UI unavailable");
                }
            }, null, () -> true, null);
        }
        SessionExecutionState.Turn begin() {
            SessionExecutionState.Turn turn = execution.beginTurn();
            adapter.onStateChange(true, true, null);
            return turn;
        }
        void idle() { adapter.onStateChange(false, false, null); }
        @Override public void close() { adapter.dispose(); coalescer.dispose(); }
    }

    @Test
    public void preloadedHistoryAndIdleFlagsDoNotReportCompletion() {
        try (Fixture f = new Fixture()) {
            f.adapter.onStateChange(false, true, null);
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "history")));
            f.idle();
            assertEquals(0, f.completions.get());
            assertEquals(0, f.starts.get());
        }
    }

    @Test
    public void intermediateRepliesToolBoundariesAndStreamEndWaitForTheSdkTerminalResult() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn turn = f.begin();
            f.adapter.onStreamStart();
            f.adapter.onContentDelta("checking the tool result");
            f.adapter.onBlockReset();
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "working")));
            f.adapter.onStreamEnd();
            f.idle();
            assertEquals(0, f.completions.get());
            assertEquals(1, f.starts.get());
            f.execution.finish(turn, SessionExecutionState.Outcome.SUCCEEDED);
            f.idle();
            f.idle();
            assertEquals(1, f.completions.get());
        }
    }

    @Test
    public void nonStreamingSuccessAlsoReportsExactlyOneCompletion() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn turn = f.begin();
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "reply")));
            assertEquals(0, f.completions.get());
            f.execution.finish(turn, SessionExecutionState.Outcome.SUCCEEDED);
            for (int i = 0; i < 20; i++) f.idle();
            assertEquals(1, f.completions.get());
        }
    }

    @Test
    public void waitingForUserAndFailedCancelledOrUnknownTurnsDoNotSignalSuccess() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn turn = f.begin();
            f.execution.beginInteraction(turn, SessionExecutionState.WaitReason.PERMISSION);
            f.idle();
            assertEquals(0, f.completions.get());
            f.execution.finish(turn, SessionExecutionState.Outcome.FAILED);
            f.idle();
            turn = f.begin();
            f.execution.finish(turn, SessionExecutionState.Outcome.CANCELLED);
            f.idle();
            turn = f.begin();
            f.execution.activity(turn, SessionExecutionState.Phase.UNKNOWN);
            f.idle();
            assertEquals(0, f.completions.get());
        }
    }

    @Test
    public void aNewTurnRetiresOldCompletionAndCannotAnnounceWhileStillLoading() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn first = f.begin();
            f.execution.finish(first, SessionExecutionState.Outcome.SUCCEEDED);
            f.idle();
            SessionExecutionState.Turn second = f.begin();
            f.execution.finish(first, SessionExecutionState.Outcome.SUCCEEDED);
            f.idle();
            assertEquals(1, f.completions.get());
            f.execution.finish(second, SessionExecutionState.Outcome.SUCCEEDED);
            f.adapter.onStateChange(false, true, null);
            assertEquals(1, f.completions.get());
            f.idle();
            assertEquals(2, f.completions.get());
            assertEquals(2, f.starts.get());
        }
    }

    @Test
    public void attachingAfterCompletionAndRetiringCallbacksStaySilent() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn turn = f.begin();
            f.execution.finish(turn, SessionExecutionState.Outcome.SUCCEEDED);
            SessionCallbackAdapter restored = f.adapter();
            try { restored.onStateChange(false, false, null); }
            finally { restored.dispose(); }
            f.adapter.deactivate();
            f.idle();
            assertEquals(0, f.completions.get());
        }
    }

    @Test
    public void failedNotificationsCannotSuppressTheFinalReplyOrStreamEnd() {
        try (Fixture f = new Fixture()) {
            SessionExecutionState.Turn turn = f.begin();
            f.failNotification.set(true);
            f.adapter.onStreamStart();
            f.adapter.onContentDelta("reply");
            f.adapter.onBlockReset();
            f.adapter.onStreamEnd();
            f.execution.finish(turn, SessionExecutionState.Outcome.SUCCEEDED);
            f.idle();
            assertEquals(1, f.completions.get());
            assertEquals(1, f.calls.stream().filter("onContentDelta"::equals).count());
            assertEquals(1, f.calls.stream().filter("onStreamEnd"::equals).count());
        }
    }
}
