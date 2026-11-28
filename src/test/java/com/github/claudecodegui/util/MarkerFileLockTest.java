package com.github.claudecodegui.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class MarkerFileLockTest {

    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void aLongOperationKeepsItsLockPastTheAbandonedAge() throws Exception {
        Path lockFile = this.folder.getRoot().toPath().resolve("session.jsonl");

        try (MarkerFileLock holder = MarkerFileLock.acquire(lockFile, 0, 600, 50)) {
            assertNotNull(holder);
            Thread.sleep(1_500);

            assertNull(MarkerFileLock.acquire(lockFile, 300, 600, 50));
            assertTrue(Files.exists(MarkerFileLock.markerOf(lockFile)));
        }
    }

    @Test
    public void onlyOneWaiterAtATimeMayRemoveAnAbandonedMarker() throws Exception {
        Path lockFile = this.folder.getRoot().toPath().resolve("config.json.lock");
        Path marker = this.abandonedMarker(lockFile);
        Path otherRemover = Files.createFile(marker.resolveSibling(marker.getFileName() + ".break"));

        assertNull(MarkerFileLock.acquire(lockFile, 200));

        assertEquals("crashed-process", Files.readString(marker));
        assertTrue(Files.exists(otherRemover));
    }

    @Test
    public void releasingDoesNotRemoveAMarkerTakenOverByAnotherProcess() throws Exception {
        Path lockFile = this.folder.getRoot().toPath().resolve("config.json.lock");
        Path marker = MarkerFileLock.markerOf(lockFile);

        try (MarkerFileLock holder = MarkerFileLock.acquire(lockFile, 0)) {
            assertNotNull(holder);
            Files.writeString(marker, "other-process");
        }

        assertEquals("other-process", Files.readString(marker));
    }

    private Path abandonedMarker(Path lockFile) throws Exception {
        Path marker = Files.writeString(MarkerFileLock.markerOf(lockFile), "crashed-process");
        Files.setLastModifiedTime(marker, FileTime.from(Instant.now().minusSeconds(3600)));
        return marker;
    }
}
