package com.github.claudecodegui.hooks;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.Assume;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.util.EnumSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Regression tests for safe source editing, backup and revision checks. */
public class HookMutationServiceTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void writesClaudeSettingsWithBackupAndRejectsStaleRevision() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude"))
                .resolve("settings.json");
        Files.writeString(settings, "{\n  \"hooks\": {}\n}\n", StandardCharsets.UTF_8);
        HookMutationService service = new HookMutationService(home);

        JsonObject source = service.read(null, settings.toString());
        assertTrue(source.get("lastModified").getAsLong() > 0);
        assertEquals(settings.getParent().resolve(".ccgui-hooks-backups").toAbsolutePath().normalize(),
                Path.of(source.get("backupDirectory").getAsString()).toAbsolutePath().normalize());
        String revision = source.get("revision").getAsString();
        String updated = "{\n  \"hooks\": {},\n  \"env\": {\"TOKEN\": \"keep\"}\n}\n";
        JsonObject saved = service.write(null, settings.toString(), revision, updated);

        assertTrue(saved.toString(), saved.get("success").getAsBoolean());
        assertTrue(saved.get("lastModified").getAsLong() > 0);
        assertEquals(updated, Files.readString(settings, StandardCharsets.UTF_8));
        assertTrue(Files.isRegularFile(Path.of(saved.get("backupPath").getAsString())));

        JsonObject conflict = service.write(null, settings.toString(), revision, updated);
        assertFalse(conflict.get("success").getAsBoolean());
        assertEquals("HOOK_REVISION_CONFLICT", conflict.get("errorCode").getAsString());
    }

    @Test
    public void validatesJsonAndRejectsPathsOutsideHookLocations() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude"))
                .resolve("settings.json");
        Files.writeString(settings, "{}", StandardCharsets.UTF_8);
        Path outside = home.resolve("outside.json");
        Files.writeString(outside, "{}", StandardCharsets.UTF_8);
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, settings.toString()).get("revision").getAsString();

        JsonObject invalid = service.write(null, settings.toString(), revision, "not-json");
        assertFalse(invalid.get("success").getAsBoolean());
        assertEquals("SETTINGS_NOT_OBJECT", invalid.get("errorCode").getAsString());

        JsonObject rejected = service.read(null, outside.toString());
        assertFalse(rejected.get("success").getAsBoolean());
        assertEquals("INVALID_HOOK_PATH", rejected.get("errorCode").getAsString());
    }

    @Test
    public void createsDistinctBackupsForRapidSaves() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path settings = Files.createDirectories(home.resolve(".claude"))
                .resolve("settings.json");
        Files.writeString(settings, "{}", StandardCharsets.UTF_8);
        HookMutationService service = new HookMutationService(home);

        JsonObject firstRead = service.read(null, settings.toString());
        JsonObject firstSave = service.write(null, settings.toString(),
                firstRead.get("revision").getAsString(), "{\"a\":1}");
        JsonObject secondSave = service.write(null, settings.toString(),
                firstSave.get("revision").getAsString(), "{\"a\":2}");

        assertTrue(firstSave.get("success").getAsBoolean());
        assertTrue(secondSave.get("success").getAsBoolean());
        assertFalse(firstSave.get("backupPath").getAsString()
                .equals(secondSave.get("backupPath").getAsString()));
    }

    @Test
    public void readsHookThroughDirectoryLinkWithoutEscapingConfiguredHome() throws Exception {
        Path realHome = temporaryFolder.newFolder("real-home").toPath();
        Path aliasHome = temporaryFolder.getRoot().toPath().resolve("home-alias");
        try {
            Files.createSymbolicLink(aliasHome, realHome);
        } catch (UnsupportedOperationException | SecurityException | java.io.IOException e) {
            Assume.assumeTrue("Directory links are unavailable", false);
        }
        Path hook = Files.createDirectories(realHome.resolve(".codemoss").resolve("hooks"))
                .resolve("guard.py");
        Files.writeString(hook, "print('ok')\n", StandardCharsets.UTF_8);

        JsonObject result = new HookMutationService(aliasHome).read(null,
                aliasHome.resolve(".codemoss/hooks/guard.py").toString());

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertEquals("print('ok')\n", result.get("content").getAsString());
    }

    @Test
    public void editsCodexConfigAndRejectsInvalidToml() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path config = Files.createDirectories(home.resolve(".codex")).resolve("config.toml");
        Files.writeString(config, """
                [features]
                hooks = true
                """, StandardCharsets.UTF_8);
        HookMutationService service = new HookMutationService(home);
        JsonObject source = service.read(null, config.toString());

        assertTrue(source.toString(), source.get("success").getAsBoolean());
        JsonObject invalid = service.write(null, config.toString(),
                source.get("revision").getAsString(), "[[hooks.pre_tool_use]\n");

        assertFalse(invalid.get("success").getAsBoolean());
        assertEquals("INVALID_TOML", invalid.get("errorCode").getAsString());
    }

    @Test
    public void preservesPosixPermissionsWhenReplacingSource() throws Exception {
        Path home = temporaryFolder.getRoot().toPath();
        Path hook = Files.createDirectories(home.resolve(".codemoss").resolve("hooks"))
                .resolve("guard.sh");
        Files.writeString(hook, "echo before\n", StandardCharsets.UTF_8);
        PosixFileAttributeView view = Files.getFileAttributeView(hook, PosixFileAttributeView.class);
        Assume.assumeNotNull(view);
        EnumSet<PosixFilePermission> expected = EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE);
        Files.setPosixFilePermissions(hook, expected);
        HookMutationService service = new HookMutationService(home);
        String revision = service.read(null, hook.toString()).get("revision").getAsString();

        JsonObject result = service.write(null, hook.toString(), revision, "echo after\n");

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertEquals(expected, Files.getPosixFilePermissions(hook));
    }
}
