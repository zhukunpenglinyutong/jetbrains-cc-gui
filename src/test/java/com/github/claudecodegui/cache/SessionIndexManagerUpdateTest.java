package com.github.claudecodegui.cache;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Verifies that Claude index update detection follows individual session-file changes instead of
 * relying only on the project directory timestamp.
 */
public class SessionIndexManagerUpdateTest {

    private static final String SESSION_ID = "aaaaaaaa-1111-4111-8111-111111111111";
    private static final long INDEXED_FILE_MTIME = 1_700_000_000_000L;
    private static final long DIRECTORY_MTIME = 1_700_000_100_000L;

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void getUpdateType_detectsModifiedSessionWhenDirectoryMtimeIsUnchanged() throws IOException {
        Path projectDir = tmp.newFolder("claude-project").toPath();
        Path sessionFile = projectDir.resolve(SESSION_ID + ".jsonl");
        Files.writeString(sessionFile, "initial\n");
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        SessionIndexManager.ProjectIndex projectIndex = projectIndex(INDEXED_FILE_MTIME);
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("codemoss-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(projectIndex, projectDir));

        Files.writeString(sessionFile, "appended\n", java.nio.file.StandardOpenOption.APPEND);
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME + 2_000));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        assertEquals(SessionIndexManager.UpdateType.INCREMENTAL, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void getUpdateType_detectsSizeChangeWhenMtimeIsUnchanged() throws IOException {
        Path projectDir = tmp.newFolder("claude-project-size").toPath();
        Path sessionFile = projectDir.resolve(SESSION_ID + ".jsonl");
        Files.writeString(sessionFile, "initial\n");
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        SessionIndexManager.ProjectIndex projectIndex = projectIndex(INDEXED_FILE_MTIME);
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("codemoss-cache-size").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(projectIndex, projectDir));

        Files.writeString(
                sessionFile,
                "appended\n",
                java.nio.file.StandardOpenOption.APPEND
        );
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        assertEquals(SessionIndexManager.UpdateType.INCREMENTAL, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void getUpdateType_rechecksLegacyEntrypointEntries() throws IOException {
        Path projectDir = tmp.newFolder("claude-project-legacy").toPath();
        Path sessionFile = projectDir.resolve(SESSION_ID + ".jsonl");
        Files.writeString(sessionFile, "session\n");
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        SessionIndexManager.ProjectIndex projectIndex = projectIndex(INDEXED_FILE_MTIME);
        projectIndex.sessions.get(0).entrypoint = null;
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("codemoss-cache-legacy").toPath());

        assertEquals(SessionIndexManager.UpdateType.INCREMENTAL, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void getUpdateType_rebuildsWhenSessionIsReplacedAtTheSameFileCount() throws IOException {
        Path projectDir = tmp.newFolder("replaced-session").toPath();
        Files.writeString(projectDir.resolve("bbbbbbbb-2222-4222-8222-222222222222.jsonl"), "new session\n");
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("replaced-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.FULL, manager.getUpdateType(projectIndex(INDEXED_FILE_MTIME), projectDir));
    }

    @Test
    public void getUpdateType_acceptsUppercaseFilenameAndLegacyMissingPath() throws IOException {
        Path projectDir = tmp.newFolder("uppercase-session").toPath();
        Path sessionFile = projectDir.resolve(SESSION_ID.toUpperCase(java.util.Locale.ROOT) + ".jsonl");
        Files.writeString(sessionFile, "session\n");
        Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));
        SessionIndexManager.ProjectIndex index = projectIndex(INDEXED_FILE_MTIME);
        index.sessions.get(0).fileRelativePath = null;
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("uppercase-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(index, projectDir));
        index.sessions.get(0).fileLastModified = 0;
        assertEquals(SessionIndexManager.UpdateType.INCREMENTAL, manager.getUpdateType(index, projectDir));
    }

    @Test
    public void getUpdateType_acceptsAnUnchangedEmptyProject() throws IOException {
        Path projectDir = tmp.newFolder("empty-project").toPath();
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = DIRECTORY_MTIME;
        projectIndex.fileCount = 0;
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("empty-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void getUpdateType_doesNotRescanPersistentEmptySessionFile() throws IOException {
        Path projectDir = tmp.newFolder("empty-session-file").toPath();
        Files.createFile(projectDir.resolve(SESSION_ID + ".jsonl"));
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = DIRECTORY_MTIME;
        projectIndex.fileCount = 1;
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("empty-session-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void getUpdateType_ignoresUnindexedSessionFileWhenDirectoryIsUnchanged() throws IOException {
        // A non-empty session file that never produces an index entry (single-message or
        // truncated session) must not trigger a rescan on every read while the directory
        // itself is unchanged; a later directory change still surfaces it as incremental.
        Path projectDir = tmp.newFolder("unindexed-session").toPath();
        Path indexedFile = projectDir.resolve(SESSION_ID + ".jsonl");
        Files.writeString(indexedFile, "initial\n");
        Files.setLastModifiedTime(indexedFile, FileTime.fromMillis(INDEXED_FILE_MTIME));
        Files.writeString(projectDir.resolve("bbbbbbbb-2222-4222-8222-222222222222.jsonl"), "single line\n");
        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME));

        SessionIndexManager.ProjectIndex projectIndex = projectIndex(INDEXED_FILE_MTIME);
        projectIndex.fileCount = 2;
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("unindexed-cache").toPath());

        assertEquals(SessionIndexManager.UpdateType.NONE, manager.getUpdateType(projectIndex, projectDir));

        Files.setLastModifiedTime(projectDir, FileTime.fromMillis(DIRECTORY_MTIME + 1_000));
        assertEquals(SessionIndexManager.UpdateType.INCREMENTAL, manager.getUpdateType(projectIndex, projectDir));
    }

    @Test
    public void saveClaudeProjectIndex_preservesOtherProjects() throws IOException {
        SessionIndexManager manager = new SessionIndexManager(tmp.newFolder("project-merge-cache").toPath());
        SessionIndexManager.ProjectIndex firstProject = new SessionIndexManager.ProjectIndex();
        SessionIndexManager.ProjectIndex secondProject = new SessionIndexManager.ProjectIndex();

        manager.saveClaudeProjectIndex("first", firstProject);
        manager.saveClaudeProjectIndex("second", secondProject);

        SessionIndexManager.SessionIndex saved = manager.readClaudeIndex();
        assertNotNull(saved.projects.get("first"));
        assertNotNull(saved.projects.get("second"));
        assertEquals(0, saved.projects.get("first").sessions.size());
        assertEquals(0, saved.projects.get("second").sessions.size());
    }

    private SessionIndexManager.ProjectIndex projectIndex(long fileMtime) {
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = DIRECTORY_MTIME;
        projectIndex.fileCount = 1;
        SessionIndexManager.SessionIndexEntry entry = SessionIndexManager.createEntry(
                SESSION_ID,
                "Existing session",
                1,
                1_700_000_000_000L,
                1_700_000_000_000L,
                8L,
                fileMtime,
                null,
                ""
        );
        entry.fileRelativePath = SESSION_ID + ".jsonl";
        projectIndex.sessions.add(entry);
        return projectIndex;
    }
}
