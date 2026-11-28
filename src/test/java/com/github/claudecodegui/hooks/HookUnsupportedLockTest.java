package com.github.claudecodegui.hooks;

import com.github.claudecodegui.util.MarkerFileLock;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class HookUnsupportedLockTest {

    private static final String CLAUDE_HOOK =
            "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo ready\"}]}]}}";

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @After
    public void restoreRealFileSystem() {
        HookLocalStorage.setChannelOpener(null);
        HookLocalStorage.setLockAttempt(null);
        HookLocalStorage.setHardLink(null);
    }

    @Test
    public void saveSucceedsWhenIjentCannotOpenOrLockTheLockFile() throws Exception {
        this.useIjentLockFileOpen();
        this.assertSaveSucceeds();
    }

    @Test
    public void saveSucceedsWhenIjentDoesNotImplementTryLock() throws Exception {
        HookLocalStorage.setLockAttempt(channel -> {
            throw new kotlin.NotImplementedError("Not yet implemented");
        });
        this.assertSaveSucceeds();
    }

    @Test
    public void saveSucceedsWhenTheProviderDoesNotSupportLocking() throws Exception {
        HookLocalStorage.setLockAttempt(channel -> {
            throw new UnsupportedOperationException("Locking unsupported");
        });
        this.assertSaveSucceeds();
    }

    @Test
    public void saveIsRejectedWhileAnotherProcessHoldsTheFallbackLock() throws Exception {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path settings = this.writeClaudeSettings(home, "{}");
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, settings.toString()).get("revision").getAsString();
        Path lockDirectory = HookLocalStorage.directory(home, "backups", settings);
        HookLocalStorage.prepare(home, lockDirectory);
        this.useIjentLockFileOpen();

        try (MarkerFileLock other = MarkerFileLock.acquire(lockDirectory.resolve(".ccgui-hooks.lock"), 0)) {
            assertNotNull(other);
            JsonObject result = service.write(null, settings.toString(), revision, "{\"hooks\":{}}");

            assertFalse(result.get("success").getAsBoolean());
            assertEquals("HOOK_FILE_LOCKED", result.get("errorCode").getAsString());
            assertEquals("{}", Files.readString(settings));
        }

        assertTrue(service.write(null, settings.toString(), revision, "{\"hooks\":{}}").get("success").getAsBoolean());
    }

    @Test
    public void toggleSucceedsWhenIjentCannotOpenOrLockTheLockFile() throws Exception {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path settings = this.writeClaudeSettings(home, CLAUDE_HOOK);
        JsonObject item = firstHook(home);
        this.useIjentLockFileOpen();

        JsonObject result = new HookToggleService(home).toggle(null, toggleOff(item));

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertFalse(Files.readString(settings).contains("echo ready"));
        assertNoMarkersLeft(home);
    }

    @Test
    public void firstCodexToggleSucceedsWhenIjentDoesNotImplementHardLinks() throws Exception {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path config = home.resolve(".codex").resolve("config.toml");
        this.useIjentHardLink();

        JsonObject result = new HookMutationService(home).writeNativeState(null, config, "missing", "[features]\nhooks = true\n");

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertEquals("[features]\nhooks = true\n", Files.readString(config));
        try (Stream<Path> files = Files.list(config.getParent())) {
            assertEquals(List.of(config), files.toList());
        }
    }

    @Test
    public void creatingCodexStateNeverReplacesAFileThatAppearedMeanwhile() throws Exception {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path config = home.resolve(".codex").resolve("config.toml");
        HookLocalStorage.setHardLink((link, existing) -> {
            Files.writeString(link, "# written by someone else\n");
            throw new kotlin.NotImplementedError("Not yet implemented");
        });

        JsonObject result = new HookMutationService(home).writeNativeState(null, config, "missing", "[features]\nhooks = true\n");

        assertFalse(result.get("success").getAsBoolean());
        assertEquals("HOOK_REVISION_CONFLICT", result.get("errorCode").getAsString());
        assertEquals("# written by someone else\n", Files.readString(config));
    }

    private void assertSaveSucceeds() throws Exception {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path settings = this.writeClaudeSettings(home, "{}");
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, settings.toString()).get("revision").getAsString();

        JsonObject result = service.write(null, settings.toString(), revision, "{\"hooks\":{}}");

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertEquals("{\"hooks\":{}}", Files.readString(settings));
        assertNoMarkersLeft(home);
    }

    private static void assertNoMarkersLeft(Path home) throws Exception {
        try (Stream<Path> files = Files.walk(home)) {
            assertEquals(List.of(), files.filter(path -> path.getFileName().toString().contains(".held")).toList());
        }
    }

    private Path writeClaudeSettings(Path home, String content) throws Exception {
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings, content);
        return settings;
    }

    private void useIjentLockFileOpen() {
        HookLocalStorage.setChannelOpener(file -> {
            throw new kotlin.NotImplementedError("An operation is not implemented: WRITE + NOFOLLOW_LINKS");
        });
    }

    private void useIjentHardLink() {
        HookLocalStorage.setHardLink((link, existing) -> {
            throw new kotlin.NotImplementedError("Not yet implemented");
        });
    }

    private static JsonObject firstHook(Path home) {
        return new HookCatalogService(home).scan(null).getAsJsonArray("items").get(0).getAsJsonObject();
    }

    private static JsonObject toggleOff(JsonObject item) {
        JsonObject request = new JsonObject();
        for (String key : new String[] {"provider", "scope", "event", "sourceId", "format", "managedKey", "matcher"}) {
            if (item.has(key)) {
                request.add(key, item.get(key));
            }
        }
        request.add("location", item.get("rawLocation"));
        request.add("expectedRevision", item.get("revision"));
        request.addProperty("requestId", "test-request");
        request.addProperty("enabled", false);
        return request;
    }
}
