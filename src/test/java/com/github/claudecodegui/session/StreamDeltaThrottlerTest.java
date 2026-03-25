package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class StreamDeltaThrottlerTest {

    @Test
    public void batchesMultipleDeltasIntoSingleScheduledFlush() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append("Hel");
        throttler.append("lo");

        assertEquals(1, scheduler.scheduleCount);
        assertEquals(List.of(), flushed);

        now.set(50);
        scheduler.runScheduled();

        assertEquals(List.of("Hello"), flushed);
    }

    @Test
    public void flushNowEmitsPendingDeltaImmediately() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append("partial");
        throttler.flushNow();

        assertEquals(List.of("partial"), flushed);
        assertEquals(1, scheduler.cancelCount);
    }

    @Test
    public void resetDiscardsPendingData() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append("data");
        throttler.reset();
        throttler.flushNow();

        assertTrue(flushed.isEmpty());
    }

    @Test
    public void appendNullAndEmptyAreNoOps() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append(null);
        throttler.append("");

        assertEquals(0, scheduler.scheduleCount);

        throttler.flushNow();
        assertTrue(flushed.isEmpty());
    }

    @Test
    public void flushNowWithNoPendingDataDoesNotCallConsumer() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.flushNow();
        assertTrue(flushed.isEmpty());
    }

    @Test
    public void multipleFlushCyclesWork() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append("first");
        now.set(50);
        scheduler.runScheduled();

        throttler.append("second");
        now.set(100);
        scheduler.runScheduled();

        assertEquals(List.of("first", "second"), flushed);
    }

    @Test
    public void disposePreventsFurtherFlush() {
        AtomicLong now = new AtomicLong(0);
        RecordingScheduler scheduler = new RecordingScheduler();
        List<String> flushed = new ArrayList<>();
        StreamDeltaThrottler throttler = new StreamDeltaThrottler(
                50,
                flushed::add,
                scheduler,
                now::get
        );

        throttler.append("data");
        throttler.dispose();

        // Even if scheduled flush fires after dispose, consumer should not be called
        now.set(50);
        throttler.flushNow();
        assertTrue(flushed.isEmpty());
    }

    private static final class RecordingScheduler implements StreamDeltaThrottler.Scheduler {
        private Runnable scheduled;
        private int scheduleCount;
        private int cancelCount;

        @Override
        public void schedule(Runnable runnable, long delayMs) {
            this.scheduled = runnable;
            this.scheduleCount += 1;
        }

        @Override
        public void cancel() {
            this.cancelCount += 1;
            this.scheduled = null;
        }

        void runScheduled() {
            Runnable runnable = this.scheduled;
            this.scheduled = null;
            if (runnable != null) {
                runnable.run();
            }
        }
    }
}
