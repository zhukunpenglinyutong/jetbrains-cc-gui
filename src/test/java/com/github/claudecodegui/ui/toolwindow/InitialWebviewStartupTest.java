package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** First activation and remote work share one deferred browser startup. */
public class InitialWebviewStartupTest {
    @Test
    public void inactiveRestoredTabsAllocateNothingUntilRequested() {
        List<ClaudeChatWindow.InitialWebviewStartup> tabs = new ArrayList<>();
        List<Runnable> queued = new ArrayList<>();
        AtomicInteger allocations = new AtomicInteger();
        for (int i = 0; i < 20; i++) {
            tabs.add(new ClaudeChatWindow.InitialWebviewStartup());
        }
        assertEquals(0, allocations.get());
        tabs.get(7).request(() -> false, () -> true, false, queued::add, allocations::incrementAndGet);
        assertEquals(1, queued.size());
        queued.get(0).run();
        assertEquals(1, allocations.get());
        assertFalse(tabs.get(0).hasStarted());
        assertTrue(tabs.get(7).hasStarted());
    }

    @Test
    public void activationHierarchyAndRemoteWorkShareOneStartup() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        List<Runnable> queued = new ArrayList<>();
        AtomicInteger allocations = new AtomicInteger();
        for (int i = 0; i < 20; i++) {
            startup.request(() -> false, () -> true, i % 3 == 0, queued::add, allocations::incrementAndGet);
        }
        assertEquals(1, queued.size());
        assertFalse(startup.hasStarted());
        queued.get(0).run();
        startup.request(() -> false, () -> true, true, queued::add, allocations::incrementAndGet);
        assertEquals(1, queued.size());
        assertEquals(1, allocations.get());
        assertTrue(startup.hasStarted());
    }

    @Test
    public void closeBeforeActivationDoesNotQueueNativeWork() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        List<Runnable> queued = new ArrayList<>();
        startup.request(() -> true, () -> true, true, queued::add, () -> {
            throw new AssertionError("Closed tab allocated a browser");
        });
        assertTrue(queued.isEmpty());
        assertFalse(startup.hasStarted());
    }

    @Test
    public void closeAfterQueueingCancelsNativeWork() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        AtomicBoolean disposed = new AtomicBoolean();
        List<Runnable> queued = new ArrayList<>();
        AtomicInteger allocations = new AtomicInteger();
        startup.request(disposed::get, () -> true, true, queued::add, allocations::incrementAndGet);
        disposed.set(true);
        queued.get(0).run();
        startup.request(disposed::get, () -> true, true, queued::add, allocations::incrementAndGet);
        assertEquals(1, queued.size());
        assertEquals(0, allocations.get());
        assertFalse(startup.hasStarted());
    }

    @Test
    public void rejectedSchedulingCanBeRetriedByTheNextActivation() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        AtomicInteger allocations = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> startup.request(() -> false, () -> true, false, action -> {
            throw new IllegalStateException("Queue unavailable");
        }, allocations::incrementAndGet));
        List<Runnable> queued = new ArrayList<>();
        startup.request(() -> false, () -> true, false, queued::add, allocations::incrementAndGet);
        queued.get(0).run();
        assertEquals(1, allocations.get());
        assertTrue(startup.hasStarted());
    }

    @Test
    public void schedulingRaceWithProjectDisposalDoesNotEscape() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        AtomicBoolean disposed = new AtomicBoolean();
        startup.request(disposed::get, () -> true, true, action -> {
            disposed.set(true);
            throw new IllegalStateException("Project was disposed during scheduling");
        }, () -> {
            throw new AssertionError("Disposed project allocated a browser");
        });
        assertFalse(startup.hasStarted());
    }

    @Test
    public void failedInitialDispatchCanBeRetriedWithoutDuplicateQueueEntries() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        List<Runnable> queued = new ArrayList<>();
        startup.request(() -> false, () -> true, false, queued::add, () -> {
            throw new IllegalStateException("Initialization dispatch failed");
        });
        assertThrows(IllegalStateException.class, () -> queued.remove(0).run());
        assertFalse(startup.hasStarted());
        AtomicInteger allocations = new AtomicInteger();
        startup.request(() -> false, () -> true, false, queued::add, allocations::incrementAndGet);
        startup.request(() -> false, () -> true, true, queued::add, allocations::incrementAndGet);
        assertEquals(1, queued.size());
        queued.get(0).run();
        assertTrue(startup.hasStarted());
        assertEquals(1, allocations.get());
    }

    @Test
    public void tabHiddenBeforeDeliveryDefersStartupUntilItsNextActivation() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        AtomicBoolean active = new AtomicBoolean(true);
        AtomicInteger allocations = new AtomicInteger();
        List<Runnable> queued = new ArrayList<>();
        startup.request(() -> false, active::get, false, queued::add, allocations::incrementAndGet);
        active.set(false);
        queued.remove(0).run();
        assertEquals(0, allocations.get());
        assertFalse(startup.hasStarted());

        active.set(true);
        startup.request(() -> false, active::get, false, queued::add, allocations::incrementAndGet);
        queued.remove(0).run();
        assertEquals(1, allocations.get());
        assertTrue(startup.hasStarted());
    }

    @Test
    public void remoteWorkPromotesQueuedActivationWithoutAddingAnotherStartup() {
        ClaudeChatWindow.InitialWebviewStartup startup = new ClaudeChatWindow.InitialWebviewStartup();
        AtomicBoolean active = new AtomicBoolean(true);
        AtomicInteger allocations = new AtomicInteger();
        List<Runnable> queued = new ArrayList<>();
        startup.request(() -> false, active::get, false, queued::add, allocations::incrementAndGet);
        active.set(false);
        startup.request(() -> false, active::get, true, queued::add, allocations::incrementAndGet);
        assertEquals(1, queued.size());
        queued.remove(0).run();
        assertEquals(1, allocations.get());
        assertTrue(startup.hasStarted());
    }
}
