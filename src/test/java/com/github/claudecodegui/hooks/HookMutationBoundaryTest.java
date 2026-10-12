package com.github.claudecodegui.hooks;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Acceptance fixtures for external edits, refreshed revisions and rejected input. */
public class HookMutationBoundaryTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void externalEditIsRetainedUntilAnExplicitSaveAgainstTheNewBaseline() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        Files.writeString(settings, "{\"hooks\":{},\"custom\":\"initial\"}");
        HookMutationService service = new HookMutationService(home);
        String staleRevision = service.read(null, settings.toString()).get("revision").getAsString();
        String external = "{\"hooks\":{},\"custom\":\"external edit\"}";
        Files.writeString(settings, external);

        JsonObject rejected = service.write(null, settings.toString(), staleRevision,
                "{\"hooks\":{},\"custom\":\"stale draft\"}");

        assertFailure(rejected, "HOOK_REVISION_CONFLICT");
        assertEquals(external, Files.readString(settings));
        assertEquals(0, backupCount(settings));
        JsonObject refreshed = service.read(null, settings.toString());
        assertEquals(external, refreshed.get("content").getAsString());
        assertEquals(external, Files.readString(settings));
        String resolved = "{\"hooks\":{},\"custom\":\"external edit\",\"accepted\":true}";
        JsonObject saved = service.write(null, settings.toString(),
                refreshed.get("revision").getAsString(), resolved);
        assertTrue(saved.toString(), saved.get("success").getAsBoolean());
        assertEquals(resolved, Files.readString(settings));
        assertEquals(external, Files.readString(Path.of(saved.get("backupPath").getAsString())));
        JsonObject restored = service.restore(null, settings.toString(),
                saved.get("revision").getAsString(), saved.get("backupPath").getAsString());
        assertTrue(restored.toString(), restored.get("success").getAsBoolean());
        assertEquals(external, Files.readString(settings));
    }

    @Test
    public void sameSizeExternalEditWithPreservedTimestampStillConflicts() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        String original = "{\"hooks\":{},\"custom\":\"before\"}";
        String external = "{\"hooks\":{},\"custom\":\"edited\"}";
        Files.writeString(settings, original);
        FileTime timestamp = Files.getLastModifiedTime(settings);
        HookMutationService service = new HookMutationService(home);
        String staleRevision = service.read(null, settings.toString()).get("revision").getAsString();
        Files.writeString(settings, external);
        Files.setLastModifiedTime(settings, timestamp);
        assertEquals(original.length(), Files.size(settings));
        assertEquals(timestamp, Files.getLastModifiedTime(settings));

        JsonObject result = service.write(null, settings.toString(), staleRevision,
                "{\"hooks\":{},\"custom\":\"draft\"}");

        assertFailure(result, "HOOK_REVISION_CONFLICT");
        assertEquals(external, Files.readString(settings));
        assertEquals(0, backupCount(settings));
    }

    @Test
    public void invalidJsonAndUnsupportedHooksStructureLeaveSourceAndBackupsIntact() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude")).resolve("settings.json");
        String original = "{\"hooks\":{},\"unrelated\":{\"value\":17}}";
        Files.writeString(settings, original);
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, settings.toString()).get("revision").getAsString();

        assertFailure(service.write(null, settings.toString(), revision, "{\"hooks\":"), "INVALID_JSON");
        assertFailure(service.write(null, settings.toString(), revision, "{\"hooks\":[]}"), "HOOKS_NOT_OBJECT");
        assertEquals(original, Files.readString(settings));
        assertEquals(0, backupCount(settings));
        JsonObject recovered = service.write(null, settings.toString(), revision,
                "{\"hooks\":{},\"unrelated\":{\"value\":17},\"accepted\":true}");
        assertTrue(recovered.toString(), recovered.get("success").getAsBoolean());
        assertEquals(original, Files.readString(Path.of(recovered.get("backupPath").getAsString())));
    }

    @Test
    public void invalidTomlDoesNotPreventTheNextValidSave() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path config = Files.createDirectories(home.resolve(".codex")).resolve("config.toml");
        String original = "# unrelated setting\n[features]\nhooks = true\n";
        Files.writeString(config, original);
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, config.toString()).get("revision").getAsString();

        assertFailure(service.write(null, config.toString(), revision, "[[hooks.pre_tool_use]\n"), "INVALID_TOML");
        assertEquals(original, Files.readString(config));
        assertEquals(0, backupCount(config));
        JsonObject recovered = service.write(null, config.toString(), revision, original + "other = 17\n");
        assertTrue(recovered.toString(), recovered.get("success").getAsBoolean());
        assertEquals(original, Files.readString(Path.of(recovered.get("backupPath").getAsString())));
    }

    private static long backupCount(Path source) throws Exception {
        Path directory = source.getParent().resolve(".ccgui-hooks-backups");
        if (!Files.isDirectory(directory)) {
            return 0;
        }
        try (var files = Files.list(directory)) {
            return files.filter(path -> path.getFileName().toString().endsWith(".bak")).count();
        }
    }

    private static void assertFailure(JsonObject result, String code) {
        assertFalse(result.toString(), result.get("success").getAsBoolean());
        assertEquals(result.toString(), code, result.get("errorCode").getAsString());
    }
}
