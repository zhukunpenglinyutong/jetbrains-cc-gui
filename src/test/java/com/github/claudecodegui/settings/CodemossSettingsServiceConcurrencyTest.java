package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.channels.FileChannel;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

public class CodemossSettingsServiceConcurrencyTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private Field cachedHome;
    private Object previousHome;
    private Path configPath;

    @Before
    public void useIsolatedHome() throws Exception {
        cachedHome = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        cachedHome.setAccessible(true);
        previousHome = cachedHome.get(null);
        cachedHome.set(null, folder.getRoot().getAbsolutePath());
        configPath = folder.getRoot().toPath().resolve(".codemoss/config.json");
    }

    @After
    public void restoreHome() throws Exception {
        cachedHome.set(null, previousHome);
    }

    @Test
    public void settingReadModifyWriteBlocksImportAndPreservesBothChanges() throws Exception {
        PausingSettingsService service = new PausingSettingsService();
        service.setUserLanguage("zh");
        service.pauseNextRead.set(true);
        var executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> setting = executor.submit(() -> { service.setUserLanguage("en"); return null; });
            await(service.readStarted);
            try (FileChannel lock = FileChannel.open(configPath.resolveSibling("config.json.lock"), StandardOpenOption.WRITE)) {
                assertThrows(OverlappingFileLockException.class, () -> lock.tryLock());
            }
            CountDownLatch importing = new CountDownLatch(1);
            Future<?> imported = executor.submit(() -> {
                importing.countDown();
                return service.importProviderBackup("claude", backupPayload());
            });
            await(importing);
            assertBlocked(imported);
            service.releaseRead.countDown();
            setting.get(5, TimeUnit.SECONDS);
            imported.get(5, TimeUnit.SECONDS);
            JsonObject saved = service.readConfig();
            assertEquals("en", saved.get("language").getAsString());
            assertEquals(1, saved.getAsJsonObject("claude").getAsJsonObject("providers").size());
        } finally {
            service.releaseRead.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    public void settingReadsTheImportedStateAfterAnImportTransaction() throws Exception {
        CodemossSettingsService service = new CodemossSettingsService();
        service.setUserLanguage("zh");
        CountDownLatch imported = new CountDownLatch(1);
        CountDownLatch releaseImport = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> importing = executor.submit(() -> ConfigFileTransaction.call(configPath, () -> {
                var result = service.importProviderBackup("claude", backupPayload());
                imported.countDown();
                await(releaseImport);
                return result;
            }));
            await(imported);
            Future<?> setting = executor.submit(() -> { service.setFontSizeLevel(4); return null; });
            assertBlocked(setting);
            releaseImport.countDown();
            importing.get(5, TimeUnit.SECONDS);
            setting.get(5, TimeUnit.SECONDS);
            JsonObject saved = service.readConfig();
            assertEquals(4, saved.get("fontSizeLevel").getAsInt());
            assertEquals(1, saved.getAsJsonObject("claude").getAsJsonObject("providers").size());
        } finally {
            releaseImport.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    public void concurrentFacadeWritersKeepIndependentSectionsAndProviders() throws Exception {
        CodemossSettingsService service = new CodemossSettingsService();
        service.setUserLanguage("zh");
        var executor = Executors.newFixedThreadPool(5);
        try {
            List<java.util.concurrent.Callable<Void>> actions = List.of(
                    () -> { service.setUserLanguage("en"); return null; },
                    () -> { service.setFontSizeLevel(3); return null; },
                    () -> { service.setCustomWorkingDirectory("project", folder.getRoot().getAbsolutePath()); return null; },
                    () -> { service.addCodexProvider(JsonParser.parseString("{\"id\":\"codex\",\"name\":\"Synthetic\"}").getAsJsonObject()); return null; },
                    () -> { service.importProviderBackup("claude", backupPayload()); return null; }
            );
            for (Future<Void> result : executor.invokeAll(actions)) result.get(5, TimeUnit.SECONDS);
            JsonObject saved = service.readConfig();
            assertEquals("en", saved.get("language").getAsString());
            assertEquals(3, saved.get("fontSizeLevel").getAsInt());
            assertTrue(saved.getAsJsonObject("workingDirectories").has("project"));
            assertTrue(saved.getAsJsonObject("codex").getAsJsonObject("providers").has("codex"));
            assertEquals(1, saved.getAsJsonObject("claude").getAsJsonObject("providers").size());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void failedNoopAndUnreadableUpdatesDoNotRewriteConfiguration() throws Exception {
        CodemossSettingsService service = new CodemossSettingsService();
        service.setUserLanguage("en");
        String original = Files.readString(configPath);
        var modified = Files.getLastModifiedTime(configPath);
        service.updateConfig(config -> config.addProperty("language", "en"));
        assertEquals(modified, Files.getLastModifiedTime(configPath));
        assertThrows(IllegalArgumentException.class, () -> service.updateConfig(config -> {
            config.addProperty("language", "zh");
            throw new IllegalArgumentException("synthetic failure");
        }));
        assertEquals(original, Files.readString(configPath));
        Files.writeString(configPath, "broken config");
        assertThrows(IOException.class, () -> service.setUserLanguage("zh"));
        assertEquals("broken config", Files.readString(configPath));
    }

    @Test
    public void codexAccessGuardUnderItsLockDoesNotWaitForTheConfigTransaction() throws Exception {
        CodemossSettingsService service = new CodemossSettingsService();
        service.addCodexProvider(JsonParser.parseString(
                "{\"id\":\"legacy\",\"name\":\"Synthetic\",\"configToml\":\"model = 'test-model'\\n\"}").getAsJsonObject());
        service.updateConfig(config -> config.getAsJsonObject("codex").addProperty("current", "legacy"));
        Path codexDir = Files.createDirectories(folder.getRoot().toPath().resolve(".codex"));
        Files.writeString(codexDir.resolve("config.toml"), "model = 'test-model'\n");
        Field field = CodemossSettingsService.class.getDeclaredField("codexSettingsManager");
        field.setAccessible(true);
        CodexSettingsManager manager = (CodexSettingsManager) field.get(service);
        CountDownLatch transactionHeld = new CountDownLatch(1);
        CountDownLatch releaseTransaction = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            Future<?> transaction = executor.submit(() -> ConfigFileTransaction.call(configPath, () -> {
                transactionHeld.countDown();
                await(releaseTransaction);
                return null;
            }));
            await(transactionHeld);
            Future<?> guard = executor.submit(() -> {
                manager.runWithConfigAccess(() -> true, () -> assertTrue(service.isCodexConfigManagementAllowed()));
                return null;
            });
            guard.get(2, TimeUnit.SECONDS);
            releaseTransaction.countDown();
            transaction.get(5, TimeUnit.SECONDS);
            assertFalse(service.readConfig().getAsJsonObject("codex").has("appliedProviderId"));
        } finally {
            releaseTransaction.countDown();
            executor.shutdownNow();
        }
    }

    private static JsonObject backupPayload() {
        return JsonParser.parseString("{\"providers\":[{\"name\":\"Synthetic\",\"settingsConfig\":{\"model\":null}}]}").getAsJsonObject();
    }

    private static void assertBlocked(Future<?> future) throws Exception {
        try {
            future.get(200, TimeUnit.MILLISECONDS);
            fail("Read-modify-write must wait for the transaction, not write a stale snapshot");
        } catch (TimeoutException expected) {
            // The other transaction owns the full read-modify-write interval.
        }
    }

    private static void await(CountDownLatch latch) throws IOException {
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) throw new IOException("Timed out waiting for test barrier");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException(e);
        }
    }

    private static final class PausingSettingsService extends CodemossSettingsService {
        final AtomicBoolean pauseNextRead = new AtomicBoolean();
        final CountDownLatch readStarted = new CountDownLatch(1);
        final CountDownLatch releaseRead = new CountDownLatch(1);

        @Override
        public JsonObject readConfig() throws IOException {
            JsonObject config = super.readConfig();
            if (pauseNextRead.compareAndSet(true, false)) {
                readStarted.countDown();
                await(releaseRead);
            }
            return config;
        }
    }
}
