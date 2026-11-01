package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;

public class SessionCallbackAdapterUnreadTest {
    private static final class Fixture implements AutoCloseable {
        final AtomicInteger activity = new AtomicInteger();
        final AtomicBoolean failActivity = new AtomicBoolean();
        final List<String> calls = new CopyOnWriteArrayList<>();
        final StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override public boolean callJavaScript(String name, String... args) { return true; }
            @Override public boolean isDisposed() { return false; }
            @Override public HandlerContext getHandlerContext() { return null; }
        });
        final SessionCallbackAdapter adapter = new SessionCallbackAdapter(coalescer, new SessionCallbackAdapter.JsTarget() {
            @Override public void callJavaScript(String name, String... args) { calls.add(name); }
            @Override public void onAssistantActivity() {
                activity.incrementAndGet();
                if (failActivity.get()) throw new IllegalStateException("UI unavailable");
            }
        }, null, () -> true, null);
        @Override public void close() { adapter.dispose(); coalescer.dispose(); }
    }

    @Test
    public void preloadedHistoryDoesNotReportNewAssistantActivity() {
        try (Fixture f = new Fixture()) {
            f.adapter.onStateChange(false, true, null);
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "history")));
            assertEquals(0, f.activity.get());
        }
    }

    @Test
    public void nativeAssistantSnapshotsReportActivityWhileUserMessagesDoNot() {
        try (Fixture f = new Fixture()) {
            f.adapter.onStreamStart();
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "question")));
            assertEquals(0, f.activity.get());
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "reply")));
            assertEquals(1, f.activity.get());
        }
    }

    @Test
    public void nonStreamingRepliesAlsoReportActivity() {
        try (Fixture f = new Fixture()) {
            f.adapter.onStateChange(true, true, null);
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "reply")));
            assertEquals(1, f.activity.get());
        }
    }

    @Test
    public void textDeltasReportActivityAndRetiredCallbacksStaySilent() {
        try (Fixture f = new Fixture()) {
            f.adapter.onContentDelta("reply");
            f.adapter.onBlockReset();
            assertEquals(1, f.activity.get());
            f.adapter.deactivate();
            f.adapter.onContentDelta("late delta");
            f.adapter.onBlockReset();
            f.adapter.onMessageUpdate(List.of(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "late snapshot")));
            assertEquals(1, f.activity.get());
        }
    }

    @Test
    public void failedBadgeNotificationsCannotSuppressReplyOrTerminalDelivery() {
        try (Fixture f = new Fixture()) {
            f.failActivity.set(true);
            f.adapter.onStreamStart();
            f.adapter.onContentDelta("reply");
            f.adapter.onBlockReset();
            f.adapter.onStreamEnd();
            assertEquals(1, f.calls.stream().filter("onContentDelta"::equals).count());
            assertEquals(1, f.calls.stream().filter("onStreamEnd"::equals).count());
        }
    }
}
