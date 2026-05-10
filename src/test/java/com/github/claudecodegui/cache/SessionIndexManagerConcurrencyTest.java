package com.github.claudecodegui.cache;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

/**
 * Covers history delete/reload style contention: several background tasks can clear, read,
 * and rebuild the same session index after batch deletion.
 */
public class SessionIndexManagerConcurrencyTest {

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void concurrentCodexIndexOperations_keepIndexReadable() throws Exception {
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("codemoss-cache").toPath());
        ExecutorService executor = Executors.newFixedThreadPool(8);

        try {
            List<Callable<Void>> tasks = new ArrayList<>();
            for (int worker = 0; worker < 8; worker++) {
                final int workerId = worker;
                tasks.add(() -> {
                    for (int iteration = 0; iteration < 40; iteration++) {
                        manager.saveCodexIndex(createIndex(workerId, iteration));
                        assertNotNull(manager.readCodexIndex().projects);

                        if (iteration % 7 == 0) {
                            manager.clearAllCodexIndex();
                        }
                    }
                    return null;
                });
            }

            List<Future<Void>> results = executor.invokeAll(tasks);
            for (Future<Void> result : results) {
                result.get();
            }
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }

        assertNotNull(manager.readCodexIndex().projects);
        assertNoTempFilesLeft(manager.getCodexIndexPath().getParent());
    }

    private static SessionIndexManager.SessionIndex createIndex(int workerId, int iteration) {
        SessionIndexManager.SessionIndex index = new SessionIndexManager.SessionIndex();
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.fileCount = 1;
        projectIndex.lastDirScanTime = System.currentTimeMillis();

        SessionIndexManager.SessionIndexEntry entry = SessionIndexManager.createEntry(
                "session-" + workerId + "-" + iteration,
                "Title " + workerId + "-" + iteration,
                iteration + 1,
                System.currentTimeMillis(),
                System.currentTimeMillis(),
                1024L,
                System.currentTimeMillis(),
                "D:/project"
        );
        entry.fileRelativePath = entry.sessionId + ".jsonl";
        projectIndex.sessions.add(entry);
        index.projects.put("__all__", projectIndex);
        return index;
    }

    private static void assertNoTempFilesLeft(Path cacheDir) throws Exception {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(cacheDir, "*.tmp")) {
            assertFalse("temporary index files should be cleaned up", stream.iterator().hasNext());
        }
    }
}
