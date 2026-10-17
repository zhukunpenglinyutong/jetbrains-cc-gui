package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

/** Verifies failed submissions can finish before the provider starts streaming. */
public class SessionCallbackAdapterStartupFailureTest {

    /** Each failed startup owns a terminal edge after a completed streamed turn. */
    @Test
    public void endsEachStartupFailureAfterThePreviousStreamFinished() {
        verifyStartupFailures(true);
    }

    /** Repeated startup failures remain separate submissions without stream-start events. */
    @Test
    public void endsEachStartupFailureAfterAnEarlierStartupFailure() {
        verifyStartupFailures(false);
    }

    private static void verifyStartupFailures(boolean precedingStream) {
        List<String> calls = new ArrayList<>();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            /** Accepts the real coalescer's delivery without requiring a browser. */
            @Override
            public boolean callJavaScript(String name, String... args) {
                return true;
            }

            /** Keeps the destination available to exercise the complete lifecycle. */
            @Override
            public boolean isDisposed() {
                return false;
            }

            /** Omits IDE-only context because this test has no usage payload. */
            @Override
            public HandlerContext getHandlerContext() {
                return null;
            }
        });
        SessionCallbackAdapter adapter = new SessionCallbackAdapter(coalescer,
                (name, args) -> calls.add(name), null, () -> true, null);
        try {
            if (precedingStream) {
                adapter.onStreamStart();
            }
            adapter.onStreamEnd();
            assertEquals(1, calls.stream().filter("onStreamEnd"::equals).count());
            for (int index = 0; index < 2; index++) {
                calls.clear();
                adapter.onStateChange(true, true, null);
                adapter.onStateChange(true, true, null);
                adapter.onStreamEnd();
                adapter.onStreamEnd();
                assertEquals("one terminal edge per failed submission", 1,
                        calls.stream().filter("onStreamEnd"::equals).count());
            }
        } finally {
            adapter.dispose();
            coalescer.dispose();
        }
    }
}
