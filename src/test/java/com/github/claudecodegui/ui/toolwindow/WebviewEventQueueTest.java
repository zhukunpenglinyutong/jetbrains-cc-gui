package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class WebviewEventQueueTest {

    @Test
    public void mergesAdjacentContentDeltasIntoOneOrderedCall() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        queue.enqueue("onContentDelta", "a");
        queue.enqueue("onContentDelta", "b");

        assertEquals(1, scheduled.size());
        scheduled.remove(0).run();

        assertEquals(1, scripts.size());
        assertTrue(scripts.get(0).contains("window.onContentDelta('ab')"));
        queue.dispose();
    }

    @Test
    public void preservesLifecycleOrderInsteadOfCollapsingStateAcrossBoundaries() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        queue.enqueue("showLoading", "true");
        queue.enqueue("onStreamStart");
        queue.enqueue("showLoading", "false");
        scheduled.remove(0).run();

        String script = scripts.get(0);
        assertTrue(script.indexOf("window.showLoading('true')")
                < script.indexOf("window.onStreamStart()"));
        assertTrue(script.indexOf("window.onStreamStart()")
                < script.indexOf("window.showLoading('false')"));
        queue.dispose();
    }

    @Test
    public void separatesSnapshotFromStreamStartSoStartCannotCancelIt() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        queue.enqueue("updateMessages", "snapshot", "1");
        queue.enqueue("onStreamStart");
        scheduled.remove(0).run();
        scheduled.remove(0).run();

        assertEquals(2, scripts.size());
        assertTrue(scripts.get(0).contains("window.updateMessages('snapshot', '1')"));
        assertTrue(scripts.get(1).contains("window.onStreamStart()"));
        queue.dispose();
    }

    @Test
    public void dropsQueuedEventsWhenPageGenerationChanges() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        AtomicInteger pageGeneration = new AtomicInteger(1);
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = new WebviewEventQueue<>(
                browser::get,
                disposed::get,
                pageGeneration::get,
                scheduled::add,
                (ignoredBrowser, ignoredPageGeneration, script) -> scripts.add(script),
                () -> true);

        queue.enqueueRaw("window.showAskUserQuestionDialog('stale')");
        pageGeneration.set(2);
        queue.pageChanged();
        scheduled.remove(0).run();

        assertTrue("events from the previous page must not execute", scripts.isEmpty());
        queue.dispose();
    }

    @Test
    public void delayedOldPageEnqueueDoesNotEraseNewPageEvents() throws Exception {
        Object browser = new Object();
        AtomicInteger pageGeneration = new AtomicInteger(1);
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = new WebviewEventQueue<>(
                () -> browser, () -> false, pageGeneration::get, scheduled::add,
                (ignoredBrowser, ignoredPage, script) -> scripts.add(script),
                () -> true);
        WebviewEventQueue.JsCall<Object> delayedCall =
                new WebviewEventQueue.JsCall<>(browser, 1, null, new String[0], "oldPage()");
        pageGeneration.set(2);
        queue.pageChanged();
        queue.enqueueRaw("newPage()");

        // Simulate an old sender waiting for the lock while a new-page event is queued.
        java.lang.reflect.Method enqueue = WebviewEventQueue.class.getDeclaredMethod("enqueue", WebviewEventQueue.JsCall.class);
        enqueue.setAccessible(true);
        enqueue.invoke(queue, delayedCall);
        scheduled.remove(0).run();

        assertEquals(1, scripts.size());
        assertTrue(scripts.get(0).contains("newPage()"));
        org.junit.Assert.assertFalse(scripts.get(0).contains("oldPage()"));
    }

    @Test
    public void retainsRecoverySnapshotWhenQueueContainsOnlyLifecycleCalls() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        for (int i = 0; i < 256; i++) {
            queue.enqueueRaw("lifecycle-" + i + "()");
        }
        assertTrue("the lifecycle-only queue should be full", scheduled.size() > 0);
        queue.enqueue("updateMessages", "newest-snapshot", "257");

        scheduled.remove(0).run();

        assertTrue(
                "the newest structural snapshot must survive queue pressure",
                scripts.stream().anyMatch(script -> script.contains("newest-snapshot"))
        );
        queue.dispose();
    }

    @Test
    public void requeuesBatchWhenScriptExecutionFails() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        AtomicBoolean failFirstAttempt = new AtomicBoolean(true);
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = new WebviewEventQueue<>(
                browser::get,
                disposed::get,
                () -> 0,
                scheduled::add,
                (ignoredBrowser, ignoredPageGeneration, script) -> {
                    if (failFirstAttempt.getAndSet(false)) {
                        return false;
                    }
                    scripts.add(script);
                    return true;
                },
                () -> true
        );

        queue.enqueue("updateMessages", "retry-me", "1");
        scheduled.remove(0).run();
        assertEquals(1, scheduled.size());
        scheduled.remove(0).run();

        assertEquals(1, scripts.size());
        assertTrue(scripts.get(0).contains("retry-me"));
        queue.dispose();
    }

    @Test
    public void abandonsABatchThatKeepsFailingInsteadOfRetryingForever() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        AtomicInteger attempts = new AtomicInteger();
        List<Runnable> scheduled = new ArrayList<>();
        WebviewEventQueue<Object> queue = new WebviewEventQueue<>(
                browser::get,
                disposed::get,
                () -> 0,
                scheduled::add,
                (ignoredBrowser, ignoredPageGeneration, script) -> {
                    attempts.incrementAndGet();
                    return false;
                },
                () -> true
        );

        queue.enqueue("updateMessages", "never-executes", "1");
        // Every drain fails, so the queue must give up rather than reschedule
        // itself forever on the UI thread: one initial attempt plus three retries.
        for (int i = 0; i < 10 && !scheduled.isEmpty(); i++) {
            scheduled.remove(0).run();
        }

        assertEquals(4, attempts.get());
        assertTrue("a permanently failing batch must stop being retried", scheduled.isEmpty());
        queue.dispose();
    }

    @Test
    public void retainsEventsUntilFrontendIsReady() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        AtomicBoolean ready = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = new WebviewEventQueue<>(
                browser::get,
                disposed::get,
                () -> 0,
                scheduled::add,
                (ignoredBrowser, ignoredPageGeneration, script) -> {
                    scripts.add(script);
                    return true;
                },
                ready::get
        );

        queue.enqueue("onStreamStart");
        scheduled.remove(0).run();
        assertTrue(scripts.isEmpty());

        ready.set(true);
        queue.readyChanged();
        scheduled.remove(0).run();
        assertEquals(1, scripts.size());
        assertTrue(scripts.get(0).contains("window.onStreamStart()"));
        queue.dispose();
    }

    @Test
    public void dropsTaskEventsBeyondTheSoftBoundInsteadOfGrowingUnbounded() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        // Task events re-upsert the same state on the next tick, so they are the
        // right thing to shed when the queue fills: they are neither critical
        // lifecycle nor a message snapshot, so they never take the overflow path.
        for (int i = 1; i <= 300; i++) {
            queue.enqueue("onTaskEvent", "{\"id\":\"task-" + i + "\"}");
        }

        while (!scheduled.isEmpty()) {
            scheduled.remove(0).run();
        }
        String allScripts = String.join("\n", scripts);
        assertTrue("the first 256 task events fit inside the soft bound",
                allScripts.contains("{\"id\":\"task-1\"}"));
        assertTrue("the last event inside the bound still fits",
                allScripts.contains("{\"id\":\"task-256\"}"));
        assertFalse("the overflow is dropped, not buffered",
                allScripts.contains("{\"id\":\"task-300\"}"));
        queue.dispose();
    }

    @Test
    public void recoveryEventsStopExceedingTheSoftBoundAtTheOverflowCeiling() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        // clearMessages is a critical boundary, so it is admitted past the soft bound
        // of 256 rather than shed like a task event would be. That exemption exists
        // because the real callers are low-frequency; the ceiling is what keeps a
        // caller that violates that assumption from growing the queue without limit.
        int accepted = 0;
        for (int i = 1; i <= 600; i++) {
            if (queue.enqueue("clearMessages", "{\"id\":" + i + "}")) {
                accepted++;
            }
        }

        assertEquals("recovery events overflow to 512 and are dropped past it", 512, accepted);
        queue.dispose();
    }

    @Test
    public void messageSnapshotTakesTheOverflowRatherThanBeingShed() {
        AtomicReference<Object> browser = new AtomicReference<>(new Object());
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(browser, disposed, scheduled, scripts);

        for (int i = 1; i <= 256; i++) {
            queue.enqueue("onTaskEvent", "{\"id\":\"task-" + i + "\"}");
        }
        // The transcript snapshot is the only copy the frontend would get, so it
        // exceeds the soft bound instead of being dropped behind the task events.
        queue.enqueue("updateMessages", "{\"transcript\":true}", "1");

        while (!scheduled.isEmpty()) {
            scheduled.remove(0).run();
        }
        assertTrue("the transcript snapshot must reach the frontend",
                String.join("\n", scripts).contains("{\"transcript\":true}"));
        queue.dispose();
    }

    @Test
    public void preservesSnapshotsAcrossStreamAndHistoryBoundaries() {
        for (String boundary : List.of("onStreamStart", "onStreamEnd", "clearMessages", "historyLoadComplete", "onBlockReset")) {
            List<Runnable> scheduled = new ArrayList<>();
            List<String> scripts = new ArrayList<>();
            WebviewEventQueue<Object> queue = newQueue(new AtomicReference<>(new Object()), new AtomicBoolean(), scheduled, scripts);
            queue.enqueue("updateMessages", "before", "1");
            queue.enqueue(boundary);
            queue.enqueue("updateMessages", "after", "2");
            while (!scheduled.isEmpty()) {
                scheduled.remove(0).run();
            }
            String delivered = String.join("\n", scripts);
            assertTrue(boundary, delivered.contains("'before'"));
            assertTrue(boundary, delivered.indexOf("'before'") < delivered.indexOf("window." + boundary));
            assertTrue(boundary, delivered.indexOf("window." + boundary) < delivered.indexOf("'after'"));
            queue.dispose();
        }
    }

    @Test
    public void preservesEarlierTailsThatFillTheGapBeforeALaterTail() {
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(new AtomicReference<>(new Object()), new AtomicBoolean(), scheduled, scripts);
        queue.enqueue("updateMessages", "baseline", "1");
        queue.enqueue("updateMessageTail", "first-tail", "386", "2");
        queue.enqueue("updateMessageTail", "second-tail", "436", "3");
        while (!scheduled.isEmpty()) {
            scheduled.remove(0).run();
        }
        String delivered = String.join("\n", scripts);
        assertTrue(delivered.contains("'baseline'"));
        assertTrue(delivered.contains("'first-tail'"));
        assertTrue(delivered.contains("'second-tail'"));
        queue.dispose();
    }

    @Test
    public void streamEndDoesNotEvictTheBaselineNeededByAQueuedTail() {
        List<Runnable> scheduled = new ArrayList<>();
        List<String> scripts = new ArrayList<>();
        WebviewEventQueue<Object> queue = newQueue(new AtomicReference<>(new Object()), new AtomicBoolean(), scheduled, scripts);
        queue.enqueue("updateMessages", "baseline", "1");
        queue.enqueue("updateMessageTail", "tail", "336", "2");
        for (int i = 0; i < 254; i++) {
            queue.enqueue("onTaskEvent", "task-" + i);
        }
        assertTrue(queue.enqueue("onStreamEnd", "2"));
        while (!scheduled.isEmpty()) {
            scheduled.remove(0).run();
        }
        String delivered = String.join("\n", scripts);
        assertTrue(delivered.contains("'baseline'"));
        assertTrue(delivered.contains("'tail'"));
        assertTrue(delivered.contains("window.onStreamEnd"));
        queue.dispose();
    }

    private static WebviewEventQueue<Object> newQueue(
            AtomicReference<Object> browser,
            AtomicBoolean disposed,
            List<Runnable> scheduled,
            List<String> scripts
    ) {
        return new WebviewEventQueue<>(
                browser::get,
                disposed::get,
                () -> 0,
                scheduled::add,
                (ignoredBrowser, ignoredPageGeneration, script) -> scripts.add(script),
                () -> true
        );
    }

    /**
     * The classification table decides how a call is merged and which of it may be
     * dropped, and every rule reads it through {@code hasClass}. A function that
     * silently loses a class changes that behaviour with no other symptom, so the
     * table is pinned here the way the block-type contract is pinned elsewhere.
     */
    @Test
    public void classifiesEveryWebviewFunctionItKnowsHowToEvict() {
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.DELTA),
                WebviewEventQueue.EVENT_CLASSES.get("onContentDelta"));
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.DELTA),
                WebviewEventQueue.EVENT_CLASSES.get("onThinkingDelta"));

        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.LATEST_ONLY,
                        WebviewEventQueue.EventClass.DISPOSABLE),
                WebviewEventQueue.EVENT_CLASSES.get("updateStatus"));
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.LATEST_ONLY),
                WebviewEventQueue.EVENT_CLASSES.get("showLoading"));
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.LATEST_ONLY),
                WebviewEventQueue.EVENT_CLASSES.get("setSessionId"));

        // A tail snapshot is meaningless without the full baseline it extends, so
        // only the full one may supersede it.
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.SNAPSHOT,
                        WebviewEventQueue.EventClass.LIFECYCLE),
                WebviewEventQueue.EVENT_CLASSES.get("updateMessages"));
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.SNAPSHOT,
                        WebviewEventQueue.EventClass.SNAPSHOT_TAIL,
                        WebviewEventQueue.EventClass.LIFECYCLE),
                WebviewEventQueue.EVENT_CLASSES.get("updateMessageTail"));

        // Boundaries split a batch so the snapshot queued before them is delivered
        // first; they are also the recovery points allowed past the soft bound.
        for (String boundary : List.of("onStreamStart", "clearMessages", "historyLoadComplete")) {
            assertEquals("boundary " + boundary,
                    EnumSet.of(WebviewEventQueue.EventClass.RESET_BOUNDARY,
                            WebviewEventQueue.EventClass.CRITICAL,
                            WebviewEventQueue.EventClass.LIFECYCLE),
                    WebviewEventQueue.EVENT_CLASSES.get(boundary));
        }
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.CRITICAL,
                        WebviewEventQueue.EventClass.LIFECYCLE),
                WebviewEventQueue.EVENT_CLASSES.get("onStreamEnd"));

        // Block boundaries keep subsequent deltas in the correct text segment.
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.LIFECYCLE,
                        WebviewEventQueue.EventClass.CRITICAL),
                WebviewEventQueue.EVENT_CLASSES.get("onBlockReset"));
        assertEquals(EnumSet.of(WebviewEventQueue.EventClass.LIFECYCLE),
                WebviewEventQueue.EVENT_CLASSES.get("onTaskEvent"));
    }
}
