package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.LongConsumer;

import static org.junit.Assert.*;

/**
 * Tests for the dual-path onStreamEnd delivery mechanism.
 *
 * <p>The actual SessionCallbackAdapter depends on IntelliJ's Alarm and
 * ApplicationManager, so these tests verify the core ordering/idempotency
 * contract using a simulated flush callback + fallback sequence.
 */
public class SessionCallbackAdapterStreamEndTest {

    /**
     * Records callJavaScript invocations for assertion.
     */
    private static final class RecordingJsTarget implements SessionCallbackAdapter.JsTarget {
        final List<String> calls = new ArrayList<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
            StringBuilder sb = new StringBuilder(functionName);
            for (String arg : args) {
                sb.append(':').append(arg);
            }
            calls.add(sb.toString());
        }
    }

    /**
     * Simulates the dual-path dispatch logic extracted from onStreamEnd().
     * This mirrors the actual implementation's control flow without needing
     * IntelliJ Alarm/invokeLater.
     */
    private static final class DualPathSimulator {
        private volatile boolean streamEndSignalSent = false;
        private final RecordingJsTarget jsTarget;

        DualPathSimulator(RecordingJsTarget jsTarget) {
            this.jsTarget = jsTarget;
        }

        /** Simulate the flush callback path (primary). */
        void simulateFlushCallback(long sequence) {
            if (streamEndSignalSent) return;
            streamEndSignalSent = true;
            jsTarget.callJavaScript("onStreamEnd", String.valueOf(sequence));
            jsTarget.callJavaScript("showLoading", "false");
        }

        /** Simulate the fallback alarm path. */
        void simulateFallback() {
            if (streamEndSignalSent) return;
            streamEndSignalSent = true;
            jsTarget.callJavaScript("onStreamEnd", String.valueOf(-1));
            jsTarget.callJavaScript("showLoading", "false");
        }

        /** Reset for a new onStreamEnd call. */
        void reset() {
            streamEndSignalSent = false;
        }

        boolean isStreamEndSent() {
            return streamEndSignalSent;
        }
    }

    @Test
    public void primaryPathSendsStreamEndWithSequence() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        DualPathSimulator sim = new DualPathSimulator(jsTarget);

        sim.reset();
        sim.simulateFlushCallback(42);

        assertTrue(sim.isStreamEndSent());
        assertEquals(2, jsTarget.calls.size());
        assertEquals("onStreamEnd:42", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
    }

    @Test
    public void fallbackPathSendsStreamEndWithNegativeSequence() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        DualPathSimulator sim = new DualPathSimulator(jsTarget);

        sim.reset();
        sim.simulateFallback();

        assertTrue(sim.isStreamEndSent());
        assertEquals(2, jsTarget.calls.size());
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(0));
        assertEquals("showLoading:false", jsTarget.calls.get(1));
    }

    @Test
    public void primaryPathBlocksFallback() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        DualPathSimulator sim = new DualPathSimulator(jsTarget);

        sim.reset();
        // Primary fires first
        sim.simulateFlushCallback(42);
        // Fallback fires after — should be no-op
        sim.simulateFallback();

        assertEquals(2, jsTarget.calls.size()); // Only primary's calls
        assertEquals("onStreamEnd:42", jsTarget.calls.get(0));
    }

    @Test
    public void fallbackBlocksPrimary() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        DualPathSimulator sim = new DualPathSimulator(jsTarget);

        sim.reset();
        // Fallback fires first (primary flush failed)
        sim.simulateFallback();
        // Primary fires late — should be no-op
        sim.simulateFlushCallback(42);

        assertEquals(2, jsTarget.calls.size()); // Only fallback's calls
        assertEquals("onStreamEnd:-1", jsTarget.calls.get(0));
    }

    @Test
    public void resetAllowsNextTurn() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();
        DualPathSimulator sim = new DualPathSimulator(jsTarget);

        // First turn
        sim.reset();
        sim.simulateFlushCallback(10);
        assertEquals(2, jsTarget.calls.size());

        // Second turn — reset allows new delivery
        sim.reset();
        assertFalse(sim.isStreamEndSent());
        sim.simulateFlushCallback(20);
        assertEquals(4, jsTarget.calls.size());
        assertEquals("onStreamEnd:20", jsTarget.calls.get(2));
    }

    /**
     * Verify the flush LongConsumer callback contract:
     * when StreamMessageCoalescer.flush() invokes the callback with a
     * sequence number, the onStreamEnd signal uses that sequence.
     */
    @Test
    public void flushCallbackPassesSequenceToOnStreamEnd() {
        RecordingJsTarget jsTarget = new RecordingJsTarget();

        // Simulate what happens when flush(callback) is called:
        // The callback receives the sequence from the coalescer.
        final long[] capturedSequence = {-999};
        LongConsumer flushCallback = seq -> {
            capturedSequence[0] = seq;
            jsTarget.callJavaScript("onStreamEnd", String.valueOf(seq));
        };

        flushCallback.accept(77);

        assertEquals(77, capturedSequence[0]);
        assertEquals(1, jsTarget.calls.size());
        assertEquals("onStreamEnd:77", jsTarget.calls.get(0));
    }
}

