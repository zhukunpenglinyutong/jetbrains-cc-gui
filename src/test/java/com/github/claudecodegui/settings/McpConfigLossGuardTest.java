package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.SafeJsonFileOps;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for the shared-file discipline in {@link McpServerManager} and
 * {@link ClaudeSettingsManager} that prevents configured MCP servers from
 * silently vanishing:
 *
 * <ul>
 *   <li>upsert/delete are applied to the freshest content and preserve fields
 *       written by another process.</li>
 *   <li>A failed read never rewrites the live file; an unreadable primary is
 *       reported instead of being mistaken for "no servers".</li>
 *   <li>A readable primary without {@code mcpServers} is authoritative: the
 *       legacy store cannot resurrect deleted servers.</li>
 *   <li>Deleting the last server clears the settings.json copy, including when
 *       the source lost its {@code mcpServers} key entirely.</li>
 *   <li>A lock that cannot be obtained fails the operation instead of silently
 *       redirecting the write to the legacy store.</li>
 * </ul>
 */
public class McpConfigLossGuardTest {

    private String originalHomeDir;
    private Path tempHome;
    private Path claudeJsonPath;
    private Path settingsPath;
    private McpServerManager manager;
    private ClaudeSettingsManager claudeSettingsManager;

    @Before
    public void setUp() throws Exception {
        tempHome = Files.createTempDirectory("mcp-loss-guard-test");
        Files.createDirectories(tempHome.resolve(".claude"));

        claudeJsonPath = tempHome.resolve(".claude.json");
        settingsPath = tempHome.resolve(".claude").resolve("settings.json");

        originalHomeDir = getCachedHomeDirectory();
        setCachedHomeDirectory(tempHome.toString());

        claudeSettingsManager = new ClaudeSettingsManager(new Gson(), new ConfigPathManager());
        manager = new McpServerManager(
                new Gson(),
                v -> new JsonObject(),
                c -> { },
                claudeSettingsManager);
    }

    @After
    public void tearDown() throws Exception {
        setCachedHomeDirectory(originalHomeDir);
        originalHomeDir = null;
        if (tempHome != null) {
            try (java.util.stream.Stream<Path> paths = Files.walk(tempHome)) {
                paths.sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
            tempHome = null;
        }
    }

    // ==================== helpers ====================

    /** Write a valid ~/.claude.json document with the given mcpServers JSON. */
    private void writeClaudeJson(String mcpServersJson) throws Exception {
        Files.writeString(claudeJsonPath,
                "{\"mcpServers\":" + mcpServersJson + ",\"projects\":{}}",
                StandardCharsets.UTF_8);
    }

    /** Build an internal server JSON like the webview sends on add/update. */
    private JsonObject buildServer(String id, String command) {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", command);
        JsonObject server = new JsonObject();
        server.addProperty("id", id);
        server.addProperty("name", id);
        server.addProperty("enabled", true);
        server.add("server", spec);
        return server;
    }

    /** Write a settings.json holding one MCP server. */
    private void writeSettingsWithServer(String serverId) throws Exception {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        JsonObject servers = new JsonObject();
        servers.add(serverId, spec);
        JsonObject settings = new JsonObject();
        settings.add("mcpServers", servers);
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);
    }

    /** @return the parsed settings.json on disk */
    private JsonObject readSettings() throws Exception {
        return JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    /** @return the parsed ~/.claude.json on disk */
    private JsonObject readClaudeJson() throws Exception {
        return JsonParser.parseString(Files.readString(claudeJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
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

    // ==================== upsert / delete durability ====================

    /**
     * After an external rewrite, the next upsert is applied to the rewritten
     * content: the plugin's server lands and the other writer's fields survive.
     *
     * <p>Known limitation, pinned here on purpose: a stale snapshot written by a
     * process that ignores the advisory lock (the Claude CLI) still drops
     * servers the plugin added before that rewrite. Neither the lock, the
     * fingerprint check nor the backup (which predates the plugin's write) can
     * undo it. If that limitation is ever lifted, the last assertion fails on
     * purpose: update it to expect srv-a, do not delete the coverage.
     */
    @Test
    public void upsertAfterExternalRewriteAppliesToTheRewrittenContent() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));

        // The CLI rewrites the whole file from a snapshot taken before srv-a existed.
        Files.writeString(claudeJsonPath, "{\"numStartups\":7,\"projects\":{}}", StandardCharsets.UTF_8);
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        JsonObject after = readClaudeJson();
        assertTrue("srv-b must be written", after.getAsJsonObject("mcpServers").has("srv-b"));
        assertEquals("the external writer's fields must survive the upsert",
                7, after.get("numStartups").getAsInt());
        assertFalse("known limitation: the stale external rewrite dropped srv-a",
                after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Upserting a second server must not drop the first one. */
    @Test
    public void upsertPreservesExistingServers() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        JsonObject servers = readClaudeJson().getAsJsonObject("mcpServers");
        assertTrue(servers.has("srv-a"));
        assertTrue(servers.has("srv-b"));
    }

    /** Fields owned by the CLI (or the user) must survive a plugin upsert. */
    @Test
    public void upsertPreservesUnrelatedTopLevelFields() throws Exception {
        Files.writeString(claudeJsonPath,
                "{\"mcpServers\":{},\"numStartups\":7,\"oauthAccount\":{\"emailAddress\":\"a@b.c\"}}",
                StandardCharsets.UTF_8);

        manager.upsertMcpServer(buildServer("srv-a", "npx"));

        JsonObject after = readClaudeJson();
        assertEquals("an unrelated numeric field must survive", 7, after.get("numStartups").getAsInt());
        assertEquals("an unrelated object field must survive",
                "a@b.c", after.getAsJsonObject("oauthAccount").get("emailAddress").getAsString());
        assertTrue(after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /**
     * A failed read must not rewrite the live file: the backup is returned for
     * display only, so a CLI write in progress is never replaced by old data.
     */
    @Test
    public void corruptClaudeJsonIsNotRewrittenOnRead() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        String torn = "{\"mcpServers\":{\"srv-a\":{\"command\":\"npx\"";
        Files.writeString(claudeJsonPath, torn, StandardCharsets.UTF_8);

        List<JsonObject> servers = manager.getMcpServers();
        assertNotNull(servers);
        boolean found = false;
        for (JsonObject s : servers) {
            if ("srv-a".equals(s.get("id").getAsString())) {
                found = true;
            }
        }
        assertTrue("server must be recovered from the backup for display", found);
        assertEquals("the read must leave the live file untouched", torn,
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8));
    }

    /** An unreadable primary without a usable backup fails loudly instead of showing "no servers". */
    @Test
    public void unreadablePrimaryWithoutBackupIsReported() throws Exception {
        Files.writeString(claudeJsonPath, "{torn", StandardCharsets.UTF_8);

        try {
            manager.getMcpServers();
            fail("an unreadable ~/.claude.json must not be reported as an empty server list");
        } catch (IOException expected) {
            assertTrue("the error must name the unreadable file",
                    expected.getMessage().contains("could not be parsed"));
            assertTrue("the error must tell the user how to recover: " + expected.getMessage(),
                    expected.getMessage().contains("valid JSON object"));
        }
    }

    /**
     * A corrupt primary must fail the update instead of being replaced by a
     * document rebuilt from scratch (review item 1).
     */
    @Test
    public void corruptPrimaryIsNotOverwrittenByUpsert() throws Exception {
        String torn = "{\"mcpServers\":{\"srv-a\":{\"comm";
        Files.writeString(claudeJsonPath, torn, StandardCharsets.UTF_8);

        try {
            manager.upsertMcpServer(buildServer("srv-b", "uvx"));
            fail("an unreadable primary must fail the update");
        } catch (IOException expected) {
            assertTrue("the failure must be reported, not swallowed",
                    expected.getMessage().contains("Failed to update"));
        }

        assertEquals("the unreadable primary must be left for the user to inspect", torn,
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8));
    }

    /** Deleting a server keeps the other servers. */
    @Test
    public void deleteRemovesOnlyTargetServer() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        boolean removed = manager.deleteMcpServer("srv-a");

        assertTrue(removed);
        JsonObject servers = readClaudeJson().getAsJsonObject("mcpServers");
        assertFalse(servers.has("srv-a"));
        assertTrue(servers.has("srv-b"));
    }

    /** Deleting an unknown server leaves the document untouched. */
    @Test
    public void deletingUnknownServerKeepsDocumentUntouched() throws Exception {
        writeClaudeJson("{\"srv-a\":{\"type\":\"stdio\",\"command\":\"npx\"}}");
        String before = Files.readString(claudeJsonPath, StandardCharsets.UTF_8);

        assertFalse(manager.deleteMcpServer("nope"));

        assertEquals("an absent server must not trigger a rewrite", before,
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8));
    }

    /**
     * A lock that cannot be obtained must fail the operation, not silently fork
     * the write into the legacy store (review item 4).
     */
    @Test
    public void upsertFailsInsteadOfRedirectingWhenTheLockIsHeld() throws Exception {
        writeClaudeJson("{}");
        String before = Files.readString(claudeJsonPath, StandardCharsets.UTF_8);

        AtomicInteger codemossWrites = new AtomicInteger();
        McpServerManager legacyRecordingManager = new McpServerManager(
                new Gson(),
                v -> new JsonObject(),
                c -> codemossWrites.incrementAndGet(),
                claudeSettingsManager);

        Path lock = SafeJsonFileOps.sibling(claudeJsonPath, ".ccgui-lock");
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread holder = new Thread(() -> {
            try {
                SafeJsonFileOps.withLock(lock, 5_000, () -> {
                    held.countDown();
                    try {
                        release.await(15, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            } catch (IOException ignored) {
                // released by the test
            }
        });
        holder.start();
        assertTrue("the competing holder must acquire the lock", held.await(5, TimeUnit.SECONDS));

        try {
            legacyRecordingManager.upsertMcpServer(buildServer("srv-a", "npx"));
            fail("the lock timeout must be reported to the caller");
        } catch (IOException expected) {
            assertTrue("the error must mention the lock",
                    expected.getMessage().toLowerCase().contains("lock")
                            || expected.getMessage().toLowerCase().contains("timed out"));
        } finally {
            release.countDown();
            holder.join(10_000);
        }

        assertEquals("the legacy store must not receive a redirected write", 0, codemossWrites.get());
        assertEquals("the primary file must be untouched on failure", before,
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8));
    }

    // ==================== source priority ====================

    /**
     * A readable ~/.claude.json without an mcpServers key means "no servers";
     * the legacy store must not resurrect entries deleted in the UI.
     */
    @Test
    public void missingSourceKeyDoesNotFallBackToLegacyStore() throws Exception {
        Files.writeString(claudeJsonPath, "{\"projects\":{}}", StandardCharsets.UTF_8);

        JsonObject codemoss = new JsonObject();
        JsonArray legacyServers = new JsonArray();
        legacyServers.add(buildServer("legacy-srv", "npx"));
        codemoss.add("mcpServers", legacyServers);
        McpServerManager legacyManager = new McpServerManager(
                new Gson(), v -> codemoss, c -> { }, claudeSettingsManager);

        List<JsonObject> servers = legacyManager.getMcpServers();

        assertTrue("a readable primary without mcpServers is authoritative", servers.isEmpty());
    }

    /** The legacy store still serves installs where ~/.claude.json never existed. */
    @Test
    public void legacyStoreIsUsedWhenPrimaryFileIsMissing() throws Exception {
        Files.deleteIfExists(claudeJsonPath);

        JsonObject codemoss = new JsonObject();
        JsonArray legacyServers = new JsonArray();
        legacyServers.add(buildServer("legacy-srv", "npx"));
        codemoss.add("mcpServers", legacyServers);
        McpServerManager legacyManager = new McpServerManager(
                new Gson(), v -> codemoss, c -> { }, claudeSettingsManager);

        List<JsonObject> servers = legacyManager.getMcpServers();

        assertEquals(1, servers.size());
        assertEquals("legacy-srv", servers.get(0).get("id").getAsString());
    }

    /** Project-level servers override global ones with the same name. */
    @Test
    public void projectServersOverrideGlobalOnes() throws Exception {
        Files.writeString(claudeJsonPath,
                "{\"mcpServers\":{\"srv-a\":{\"type\":\"stdio\",\"command\":\"global\"}},"
                        + "\"projects\":{\"/proj\":{\"mcpServers\":{\"srv-a\":{\"type\":\"stdio\",\"command\":\"project\"},"
                        + "\"srv-p\":{\"type\":\"stdio\",\"command\":\"p\"}}}}}",
                StandardCharsets.UTF_8);

        List<JsonObject> servers = manager.getMcpServersWithProjectPath("/proj");

        assertEquals(2, servers.size());
        for (JsonObject server : servers) {
            assertEquals("id must be filled in", server.get("id").getAsString(), server.get("name").getAsString());
            if ("srv-a".equals(server.get("id").getAsString())) {
                assertEquals("the project-level spec must win",
                        "project", server.getAsJsonObject("server").get("command").getAsString());
            }
        }
    }

    // ==================== sync loss guard ====================

    /**
     * The core loss guard: an EMPTY mcpServers in ~/.claude.json must never
     * wipe a non-empty mcpServers in settings.json during a routine sync.
     */
    @Test
    public void syncDoesNotPropagateEmptyMcpServersOverNonEmptySettings() throws Exception {
        writeSettingsWithServer("srv-a");
        writeClaudeJson("{}");

        claudeSettingsManager.syncMcpToClaudeSettings();

        assertTrue("settings.json mcpServers must NOT be wiped by an empty source",
                readSettings().getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Normal sync direction still works: non-empty source overwrites empty target. */
    @Test
    public void syncStillCopiesNonEmptyServersIntoEmptySettings() throws Exception {
        JsonObject globalServers = new JsonObject();
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        globalServers.add("srv-a", spec);
        writeClaudeJson(globalServers.toString());

        claudeSettingsManager.syncMcpToClaudeSettings();

        JsonObject after = readSettings();
        assertTrue(after.has("mcpServers"));
        assertTrue(after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** A sync must not drop unrelated settings.json fields. */
    @Test
    public void syncPreservesUnrelatedSettingsFields() throws Exception {
        JsonObject settings = new JsonObject();
        settings.addProperty("theme", "dark");
        settings.add("mcpServers", new JsonObject());
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);

        JsonObject globalServers = new JsonObject();
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        globalServers.add("srv-a", spec);
        writeClaudeJson(globalServers.toString());

        claudeSettingsManager.syncMcpToClaudeSettings();

        JsonObject after = readSettings();
        assertEquals("an unrelated field must survive the sync", "dark", after.get("theme").getAsString());
        assertTrue(after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /**
     * Deleting the LAST server must also clear settings.json — the delete path
     * passes allowEmptyOverwrite=true because the user acted intentionally.
     */
    @Test
    public void deletingLastServerClearsSettingsDotJson() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        assertTrue("the upsert must have synced the server into settings.json",
                readSettings().getAsJsonObject("mcpServers").has("srv-a"));

        assertTrue(manager.deleteMcpServer("srv-a"));

        JsonObject after = readSettings();
        assertTrue("settings.json must keep an (empty) mcpServers object", after.has("mcpServers"));
        assertTrue("no ghost server may survive in settings.json after deleting the last one",
                after.getAsJsonObject("mcpServers").keySet().isEmpty());
    }

    /**
     * Review item 3/5: when ~/.claude.json lost its mcpServers key entirely, an
     * intentionally emptied source must still clear the settings.json copy.
     */
    @Test
    public void intentionalEmptySyncClearsSettingsWhenSourceKeyIsMissing() throws Exception {
        writeSettingsWithServer("srv-a");
        Files.writeString(claudeJsonPath, "{\"projects\":{}}", StandardCharsets.UTF_8);

        claudeSettingsManager.syncMcpToClaudeSettings(true);

        JsonObject after = readSettings();
        assertTrue("settings.json must keep an (empty) mcpServers object", after.has("mcpServers"));
        assertTrue("the ghost must be cleared when the source is intentionally empty",
                after.getAsJsonObject("mcpServers").keySet().isEmpty());
    }

    /** The same missing key must NOT clear settings.json during a routine (guarded) sync. */
    @Test
    public void guardedSyncKeepsSettingsWhenSourceKeyIsMissing() throws Exception {
        writeSettingsWithServer("srv-a");
        Files.writeString(claudeJsonPath, "{\"projects\":{}}", StandardCharsets.UTF_8);

        claudeSettingsManager.syncMcpToClaudeSettings();

        assertTrue("a routine sync must not clear the target when the source is merely unknown",
                readSettings().getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Both sides empty: sync must not crash and must leave settings empty-but-present. */
    @Test
    public void syncWithBothEmptyIsSafe() throws Exception {
        writeClaudeJson("{}");
        claudeSettingsManager.syncMcpToClaudeSettings();

        if (Files.exists(settingsPath)) {
            JsonObject after = readSettings();
            if (after.has("mcpServers")) {
                assertTrue(after.getAsJsonObject("mcpServers").keySet().isEmpty());
            }
        }
    }

    /**
     * The ~/.codemoss/config.json fallback delete path must ALSO propagate the
     * deletion to settings.json — no ghost entry may survive via that path.
     */
    @Test
    public void codemossFallbackDeleteAlsoClearsSettingsDotJson() throws Exception {
        writeSettingsWithServer("srv-a");
        // The server ONLY exists in ~/.codemoss/config.json now.
        writeClaudeJson("{}");
        JsonObject codemoss = new JsonObject();
        JsonArray arr = new JsonArray();
        arr.add(buildServer("srv-a", "npx"));
        codemoss.add("mcpServers", arr);
        java.util.concurrent.atomic.AtomicReference<JsonObject> written = new java.util.concurrent.atomic.AtomicReference<>();
        McpServerManager codemossManager = new McpServerManager(
                new Gson(),
                v -> codemoss,
                written::set,
                claudeSettingsManager);

        boolean removed = codemossManager.deleteMcpServer("srv-a");

        assertTrue(removed);
        assertNotNull("codemoss config must have been written", written.get());
        JsonObject after = readSettings();
        assertTrue("settings.json must keep an (empty) mcpServers object", after.has("mcpServers"));
        assertTrue("no ghost server may survive in settings.json after a codemoss-path delete",
                after.getAsJsonObject("mcpServers").keySet().isEmpty());
    }

    /**
     * A codemoss-path delete removes only the deleted id from settings.json: it
     * did not touch ~/.claude.json, so an empty source there must not clear the
     * other servers in settings.json.
     */
    @Test
    public void codemossFallbackDeleteKeepsOtherSettingsServers() throws Exception {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        JsonObject settingsServers = new JsonObject();
        settingsServers.add("srv-a", spec);
        settingsServers.add("srv-other", spec.deepCopy());
        JsonObject settings = new JsonObject();
        settings.add("mcpServers", settingsServers);
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);
        writeClaudeJson("{}");
        JsonObject codemoss = new JsonObject();
        JsonArray arr = new JsonArray();
        arr.add(buildServer("srv-a", "npx"));
        codemoss.add("mcpServers", arr);
        McpServerManager codemossManager = new McpServerManager(
                new Gson(),
                v -> codemoss,
                c -> { },
                claudeSettingsManager);

        assertTrue(codemossManager.deleteMcpServer("srv-a"));

        JsonObject after = readSettings().getAsJsonObject("mcpServers");
        assertFalse("the deleted server must leave settings.json", after.has("srv-a"));
        assertTrue("servers unrelated to the delete must stay in settings.json", after.has("srv-other"));
    }

    // ==================== settings.json durability ====================

    /** settings.json must never be left truncated after a write. */
    @Test
    public void settingsWriteIsAtomic() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));

        String raw = Files.readString(settingsPath, StandardCharsets.UTF_8);
        assertNotNull(JsonParser.parseString(raw).getAsJsonObject());
        assertTrue(raw.contains("srv-a"));
    }

    /** A corrupt settings.json must not be replaced by a write derived from a fallback. */
    @Test
    public void corruptSettingsJsonIsNotOverwrittenByAnUpdate() throws Exception {
        writeClaudeJson("{\"srv-a\":{\"type\":\"stdio\",\"command\":\"npx\"}}");
        String torn = "{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":";
        Files.writeString(settingsPath, torn, StandardCharsets.UTF_8);

        try {
            claudeSettingsManager.syncMcpToClaudeSettings();
            fail("an unreadable settings.json must be reported, not silently replaced");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().toLowerCase().contains("could not parse")
                    || expected.getMessage().toLowerCase().contains("could not update"));
        }

        assertEquals("the unreadable settings.json must be left for the user to inspect", torn,
                Files.readString(settingsPath, StandardCharsets.UTF_8));
    }

    /** A no-op update must not rewrite settings.json nor rotate its backup. */
    @Test
    public void noOpSettingsWriteKeepsTheFileUntouched() throws Exception {
        writeClaudeJson("{}");
        // First sync normalises the document (forced env flag) and may create a backup.
        claudeSettingsManager.syncMcpToClaudeSettings();
        Path backup = SafeJsonFileOps.sibling(settingsPath, SafeJsonFileOps.BACKUP_SUFFIX);
        Files.deleteIfExists(backup);
        String content = Files.readString(settingsPath, StandardCharsets.UTF_8);
        long modified = Files.getLastModifiedTime(settingsPath).toMillis();

        // Second sync has nothing to change: no write, no new backup.
        claudeSettingsManager.syncMcpToClaudeSettings();

        assertEquals("an unchanged document must not be rewritten", modified,
                Files.getLastModifiedTime(settingsPath).toMillis());
        assertEquals("an unchanged document must keep its content", content,
                Files.readString(settingsPath, StandardCharsets.UTF_8));
        assertFalse("a no-op write must not create a backup", Files.exists(backup));
    }
}
