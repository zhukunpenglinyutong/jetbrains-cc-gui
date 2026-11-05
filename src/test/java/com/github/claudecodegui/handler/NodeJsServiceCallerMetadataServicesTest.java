package com.github.claudecodegui.handler;

import com.github.claudecodegui.testing.SessionMetadataBridgeFixture;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.Assert.assertEquals;

/**
 * Runs the real favorites-service.cjs / session-titles-service.cjs through
 * {@link NodeJsServiceCaller}.
 *
 * <p>{@code HistoryDeleteService} removes a deleted session's favorite via
 * {@code removeFavorite}, which the favorites whitelist used to reject. Once
 * that cleanup actually runs it can overlap with a rename or a favorite toggle,
 * and each service call rewrites its whole JSON file, so concurrent writers
 * must not lose each other's updates.
 */
public class NodeJsServiceCallerMetadataServicesTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final int WRITERS = 8;

    private SessionMetadataBridgeFixture fixture;

    @Before
    public void setUp() throws Exception {
        fixture = SessionMetadataBridgeFixture.create(temporaryFolder.getRoot().toPath());
    }

    @Test
    public void removeFavoriteDeletesOnlyTheGivenSession() throws Exception {
        fixture.seedFavorites("session-a", "session-b");

        // removeFavorite logs a "[Favorites] Removed favorite" line first; the
        // caller must still hand back the trailing JSON result line.
        String result = new NodeJsServiceCaller(fixture.context())
                .callNodeJsFavoritesService("removeFavorite", "session-a");

        assertEquals("true", result);
        assertEquals(Set.of("session-b"), fixture.favoriteIds());
        assertEquals(0, fixture.processManager().getActiveProcessCount());
    }

    @Test
    public void removeFavoriteOfUnfavoritedSessionIsANoOp() throws Exception {
        fixture.seedFavorites("session-b");

        String result = new NodeJsServiceCaller(fixture.context())
                .callNodeJsFavoritesService("removeFavorite", "session-a");

        assertEquals("true", result);
        assertEquals(Set.of("session-b"), fixture.favoriteIds());
    }

    @Test(timeout = 60_000)
    public void concurrentFavoriteWritesDoNotLoseUpdates() throws Exception {
        fixture.seedFavorites(sessionIds("deleted-"));
        NodeJsServiceCaller caller = new NodeJsServiceCaller(fixture.context());

        List<Callable<String>> writes = new ArrayList<>();
        for (int i = 0; i < WRITERS; i++) {
            String added = "added-" + i;
            String deleted = "deleted-" + i;
            writes.add(() -> caller.callNodeJsFavoritesService("toggleFavorite", added));
            writes.add(() -> caller.callNodeJsFavoritesService("removeFavorite", deleted));
        }
        runConcurrently(writes);

        assertEquals(Set.of(sessionIds("added-")), fixture.favoriteIds());
    }

    @Test(timeout = 60_000)
    public void concurrentTitleWritesDoNotLoseUpdates() throws Exception {
        fixture.seedTitles(sessionIds("deleted-"));
        NodeJsServiceCaller caller = new NodeJsServiceCaller(fixture.context());

        List<Callable<String>> writes = new ArrayList<>();
        for (int i = 0; i < WRITERS; i++) {
            String renamed = "renamed-" + i;
            String deleted = "deleted-" + i;
            writes.add(() -> caller.callNodeJsTitlesServiceWithParams("updateTitle", renamed, "Title " + renamed));
            writes.add(() -> caller.callNodeJsDeleteTitle(deleted));
        }
        runConcurrently(writes);

        assertEquals(Set.of(sessionIds("renamed-")), fixture.titledSessionIds());
    }

    private static String[] sessionIds(String prefix) {
        String[] ids = new String[WRITERS];
        for (int i = 0; i < WRITERS; i++) {
            ids[i] = prefix + i;
        }
        return ids;
    }

    private static void runConcurrently(List<Callable<String>> tasks) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<String>> futures = new ArrayList<>();
            for (Callable<String> task : tasks) {
                futures.add(pool.submit(() -> {
                    start.await();
                    return task.call();
                }));
            }
            start.countDown();
            for (Future<String> future : futures) {
                future.get();
            }
        } finally {
            pool.shutdownNow();
        }
    }
}
