package com.github.claudecodegui.settings;

import com.github.claudecodegui.skill.CodexSkillService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodemossSettingsServiceCodexCliLoginTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldExposeCodexCliLoginAvailabilityViaFacade() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-login-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"token-value\"}}",
                StandardCharsets.UTF_8
        );

        CodemossSettingsService service = new CodemossSettingsService();
        service.setCodexLocalConfigAuthorized(true);

        assertTrue(service.isCodexCliLoginAvailable());
    }

    @Test
    public void shouldExposeApiKeyCliLoginAvailabilityViaFacade() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-api-key-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"OPENAI_API_KEY\":\"local-key\"}",
                StandardCharsets.UTF_8
        );

        CodemossSettingsService service = new CodemossSettingsService();
        service.setCodexLocalConfigAuthorized(true);

        assertTrue(service.isCodexCliLoginAvailable());
    }

    @Test
    public void shouldReadCodexCliLoginAccountInfoViaFacade() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-account-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));

        String payload = Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString("{\"email\":\"dev@example.com\",\"name\":\"Dev User\"}"
                        .getBytes(StandardCharsets.UTF_8));
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"tokens\":{\"id_token\":\"header." + payload + ".signature\"}}",
                StandardCharsets.UTF_8
        );

        CodemossSettingsService service = new CodemossSettingsService();
        service.setCodexLocalConfigAuthorized(true);

        JsonObject accountInfo = service.readCodexCliLoginAccountInfo();

        assertNotNull(accountInfo);
        assertEquals("dev@example.com", accountInfo.get("emailAddress").getAsString());
        assertEquals("Dev User", accountInfo.get("name").getAsString());
    }

    @Test
    public void shouldHideCodexLocalFilesUntilAuthorized() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-unauthorized-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(
                tempHome.resolve(".codex").resolve("config.toml"),
                "model = \"gpt-5\"",
                StandardCharsets.UTF_8
        );
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"token-value\",\"id_token\":\"header.payload.signature\"}}",
                StandardCharsets.UTF_8
        );

        CodemossSettingsService service = new CodemossSettingsService();

        assertFalse(service.isCodexLocalConfigAuthorized());
        assertFalse(service.isCodexCliLoginAvailable());
        assertNull(service.readCodexCliLoginAccountInfo());
        assertEquals(0, service.getCurrentCodexConfig().size());
    }

    @Test
    public void shouldReadCodexLocalFilesAfterAuthorization() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-cli-authorized-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));

        String payload = Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString("{\"email\":\"dev@example.com\",\"name\":\"Dev User\"}"
                        .getBytes(StandardCharsets.UTF_8));
        Files.writeString(
                tempHome.resolve(".codex").resolve("config.toml"),
                "model = \"gpt-5\"",
                StandardCharsets.UTF_8
        );
        Files.writeString(
                tempHome.resolve(".codex").resolve("auth.json"),
                "{\"auth_mode\":\"chatgpt\",\"tokens\":{\"access_token\":\"token-value\",\"id_token\":\"header." + payload + ".signature\"}}",
                StandardCharsets.UTF_8
        );

        CodemossSettingsService service = new CodemossSettingsService();
        service.setCodexLocalConfigAuthorized(true);

        assertTrue(service.isCodexLocalConfigAuthorized());
        assertTrue(service.isCodexCliLoginAvailable());
        assertNotNull(service.readCodexCliLoginAccountInfo());
        assertTrue(service.getCurrentCodexConfig().has("config"));
        assertTrue(service.getCurrentCodexConfig().has("auth"));

        service.setCodexLocalConfigAuthorized(false);

        assertFalse(service.isCodexCliLoginAvailable());
        assertNull(service.readCodexCliLoginAccountInfo());
        assertEquals(0, service.getCurrentCodexConfig().size());
    }

    @Test
    public void shouldResolveCodexRuntimeAccessModeFromAuthorizationAndActiveProvider() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-runtime-access-home");
        useTemporaryHomeDirectory(tempHome);
        Files.createDirectories(tempHome.resolve(".codex"));

        CodemossSettingsService service = new CodemossSettingsService();

        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE, service.getCodexRuntimeAccessMode());
        assertFalse(service.isCodexConfigManagementAllowed());

        service.switchCodexProvider(CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID);
        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE, service.getCodexRuntimeAccessMode());
        assertFalse(service.isCodexConfigManagementAllowed());

        service.setCodexLocalConfigAuthorized(true);
        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN, service.getCodexRuntimeAccessMode());
        assertTrue(service.isCodexConfigManagementAllowed());

        JsonObject provider = new JsonObject();
        provider.addProperty("id", "managed-provider");
        provider.addProperty("name", "Managed Provider");
        provider.addProperty("configToml", "model = \"gpt-5\"");
        service.addCodexProvider(provider);
        service.setCodexLocalConfigAuthorized(false);
        service.switchCodexProvider("managed-provider");

        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED, service.getCodexRuntimeAccessMode());
        assertTrue(service.isCodexConfigManagementAllowed());
        Path codexSkillsDir = Files.createDirectories(tempHome.resolve(".codex").resolve("skills"));
        assertTrue(CodexSkillService.getSkillScanDirs(tempHome.toString()).stream()
                .map(scanDir -> Path.of(scanDir.path()).toAbsolutePath().normalize())
                .anyMatch(codexSkillsDir.toAbsolutePath().normalize()::equals));

        JsonObject persisted = service.readConfig().getAsJsonObject("codex");
        assertEquals("managed-provider", persisted.get("appliedProviderId").getAsString());
        assertTrue(persisted.has("appliedProviderRevision"));

        Files.writeString(
                tempHome.resolve(".codex").resolve("config.toml"),
                "model = \"tampered\"",
                StandardCharsets.UTF_8
        );

        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE, service.getCodexRuntimeAccessMode());
        assertFalse(service.isCodexConfigManagementAllowed());
    }

    @Test
    public void shouldMigrateMatchingLegacyActiveProviderToAppliedMarkers() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-legacy-provider-migration-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(codexDir.resolve("config.toml"), "model = \"legacy-model\"\n", StandardCharsets.UTF_8);

        CodemossSettingsService service = new CodemossSettingsService();
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "legacy-provider");
        provider.addProperty("name", "Legacy Provider");
        provider.addProperty("configToml", "model = \"legacy-model\"\n");
        service.addCodexProvider(provider);
        JsonObject config = service.readConfig();
        config.getAsJsonObject("codex").addProperty("current", "legacy-provider");
        service.writeConfig(config);

        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED, service.getCodexRuntimeAccessMode());
        JsonObject migrated = service.readConfig().getAsJsonObject("codex");
        assertEquals("legacy-provider", migrated.get("appliedProviderId").getAsString());
        assertTrue(migrated.has("appliedProviderRevision"));
    }

    @Test
    public void shouldRejectMismatchedLegacyActiveProviderWithoutWritingMarkers() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-legacy-provider-mismatch-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = Files.createDirectories(tempHome.resolve(".codex"));
        Files.writeString(codexDir.resolve("config.toml"), "model = \"other-model\"\n", StandardCharsets.UTF_8);

        CodemossSettingsService service = new CodemossSettingsService();
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "legacy-provider");
        provider.addProperty("name", "Legacy Provider");
        provider.addProperty("configToml", "model = \"legacy-model\"\n");
        service.addCodexProvider(provider);
        JsonObject config = service.readConfig();
        config.getAsJsonObject("codex").addProperty("current", "legacy-provider");
        service.writeConfig(config);

        assertEquals(CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE, service.getCodexRuntimeAccessMode());
        JsonObject unchanged = service.readConfig().getAsJsonObject("codex");
        assertFalse(unchanged.has("appliedProviderId"));
        assertFalse(unchanged.has("appliedProviderRevision"));
    }

    @Test
    public void shouldBlockUnauthorizedDeletionFromCodexSkillsDirectory() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-unauthorized-skill-delete-home");
        useTemporaryHomeDirectory(tempHome);
        Path skillDir = Files.createDirectories(tempHome.resolve(".codex").resolve("skills").resolve("protected-skill"));
        Path skillFile = Files.writeString(skillDir.resolve("SKILL.md"), "# Protected", StandardCharsets.UTF_8);

        JsonObject result = CodexSkillService.deleteSkill(
                "protected-skill", "user", skillFile.toString(), tempHome.toString());

        assertFalse(result.get("success").getAsBoolean());
        assertTrue(Files.exists(skillFile));
    }

    @Test
    public void shouldAllowAgentsSkillDeletionWithoutCodexAuthorization() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-agents-skill-delete-home");
        useTemporaryHomeDirectory(tempHome);
        Path skillDir = Files.createDirectories(tempHome.resolve(".agents").resolve("skills").resolve("local-skill"));
        Path skillFile = Files.writeString(skillDir.resolve("SKILL.md"), "# Local", StandardCharsets.UTF_8);

        JsonObject result = CodexSkillService.deleteSkill(
                "local-skill", "user", skillFile.toString(), tempHome.toString());

        assertTrue(result.get("success").getAsBoolean());
        assertFalse(Files.exists(skillDir));
    }

    @Test
    public void shouldDeleteNativeAncestorSkillBeyondThreeLevels() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-ancestor-skill-delete-home");
        useTemporaryHomeDirectory(tempHome);
        Path repo = Files.createDirectories(tempHome.resolve("repository"));
        Files.createDirectory(repo.resolve(".git"));
        Path ancestor = Files.createDirectory(repo.resolve("module"));
        Path cwd = Files.createDirectories(ancestor.resolve("a/b/c/d/e"));
        Path skillDir = Files.createDirectories(ancestor.resolve(".agents/skills/example"));
        Path skillFile = Files.writeString(skillDir.resolve("SKILL.md"), "# Example");

        JsonObject result = CodexSkillService.deleteSkill("example", "repo", skillFile.toString(), cwd.toString());

        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertFalse(Files.exists(skillDir));
        assertTrue(Files.isDirectory(cwd));
    }

    @Test
    public void shouldDeleteWorktreeSkillButKeepSkillsAboveItsBoundary() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-worktree-skill-delete-home");
        useTemporaryHomeDirectory(tempHome);
        Path outer = Files.createDirectory(tempHome.resolve("outer"));
        Files.createDirectory(outer.resolve(".git"));
        Path linked = Files.createDirectory(outer.resolve("linked"));
        Files.writeString(linked.resolve(".git"), "gitdir: ../.git/worktrees/linked\n");
        Path cwd = Files.createDirectories(linked.resolve("a/b/c/d"));
        Path skillDir = Files.createDirectories(linked.resolve(".agents/skills/example"));
        Path skillFile = Files.writeString(skillDir.resolve("SKILL.md"), "# Example");
        Path outside = Files.createDirectories(outer.resolve(".agents/skills/outside")).resolve("SKILL.md");
        Files.writeString(outside, "# Outside");

        assertFalse(CodexSkillService.deleteSkill("outside", "repo", outside.toString(), cwd.toString()).get("success").getAsBoolean());
        assertTrue(Files.exists(outside));
        JsonObject result = CodexSkillService.deleteSkill("example", "repo", skillFile.toString(), cwd.toString());
        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertFalse(Files.exists(skillDir));
    }

    @Test
    public void shouldResolveWorkspaceAliasesWithoutFollowingSkillLinksDuringDeletion() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-linked-skill-delete-home");
        useTemporaryHomeDirectory(tempHome);
        Path repo = Files.createDirectories(tempHome.resolve("repository"));
        Files.createDirectory(repo.resolve(".git"));
        Path skillDir = Files.createDirectories(repo.resolve(".agents/skills/example"));
        Files.writeString(skillDir.resolve("SKILL.md"), "# Example");
        Path alias = tempHome.resolve("workspace-alias");
        createDirectoryAlias(alias, repo);
        try {
            JsonObject result = CodexSkillService.deleteSkill("example", "repo", null, alias.toString());
            assertTrue(result.toString(), result.get("success").getAsBoolean());
            assertFalse(Files.exists(skillDir));

            Path outside = Files.createDirectories(tempHome.resolve("outside/victim"));
            Path protectedFile = Files.writeString(outside.resolve("SKILL.md"), "# Protected");
            Path linkedSkill = repo.resolve(".agents/skills/linked");
            createDirectoryAlias(linkedSkill, outside.getParent());
            try {
                Path escaped = linkedSkill.resolve("victim/SKILL.md");
                assertFalse(CodexSkillService.deleteSkill("victim", "repo", escaped.toString(), repo.toString()).get("success").getAsBoolean());
                assertTrue(Files.exists(protectedFile));
                JsonObject removed = CodexSkillService.deleteSkill("linked", "repo", null, repo.toString());
                assertTrue(removed.toString(), removed.get("success").getAsBoolean());
                assertTrue(Files.exists(protectedFile));

                Files.createDirectories(skillDir);
                Files.writeString(skillDir.resolve("SKILL.md"), "# Nested link");
                createDirectoryAlias(skillDir.resolve("nested"), outside.getParent());
                JsonObject nested = CodexSkillService.deleteSkill("example", "repo", null, repo.toString());
                assertTrue(nested.toString(), nested.get("success").getAsBoolean());
                assertFalse(Files.exists(skillDir));
                assertTrue(Files.exists(protectedFile));
            } finally {
                Files.deleteIfExists(linkedSkill);
            }
        } finally {
            Files.delete(alias);
        }
    }

    private void createDirectoryAlias(Path alias, Path target) throws Exception {
        if (System.getProperty("os.name", "").startsWith("Windows")) {
            Process process = new ProcessBuilder("cmd.exe", "/c", "mklink", "/J", alias.toString(), target.toString()).start();
            assertTrue(process.waitFor(10, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } else {
            Files.createSymbolicLink(alias, target);
        }
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
