package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.AgentFields;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Contract tests for the full Claude Code subagent field set (task 56).
 *
 * <p>These tests pin the agent model to the specification documented at
 * code.claude.com/docs/en/claude-directory ("Frontmatter fields by file", row
 * {@code agents/*.md}) and guarantee that entries written by an older plugin
 * version keep round-tripping losslessly.
 */
public class AgentManagerContractTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    // ------------------------------------------------------------------
    // Backward compatibility: the legacy 4-field store entry
    // ------------------------------------------------------------------

    @Test
    public void shouldReadLegacyFourFieldEntry() throws Exception {
        Path agentPath = writeConfig("""
                {
                  "agents": {
                    "legacy-uuid": {
                      "id": "legacy-uuid",
                      "name": "accessibility-expert",
                      "prompt": "You are an accessibility expert.",
                      "createdAt": 1789902892647
                    }
                  }
                }
                """);
        AgentManager manager = newManager(agentPath);

        JsonObject agent = manager.getAgent("legacy-uuid");

        assertNotNull(agent);
        assertEquals("legacy-uuid", agent.get("id").getAsString());
        assertEquals("accessibility-expert", agent.get("name").getAsString());
        assertEquals("You are an accessibility expert.", agent.get("prompt").getAsString());
        assertEquals(1789902892647L, agent.get("createdAt").getAsLong());
        // Legacy entries carry no specification fields beyond name, and must not
        // grow any on read.
        for (String field : AgentFields.SPECIFICATION_FIELDS) {
            if (field.equals("name")) {
                continue;
            }
            assertFalse("legacy entry must not gain '" + field + "'",
                    agent.has(field));
        }
    }

    @Test
    public void shouldNotRewriteLegacyEntryOnUpdate() throws Exception {
        Path agentPath = writeConfig("""
                {
                  "agents": {
                    "legacy-uuid": {
                      "id": "legacy-uuid",
                      "name": "old-name",
                      "prompt": "old prompt",
                      "createdAt": 100
                    }
                  }
                }
                """);
        AgentManager manager = newManager(agentPath);

        manager.updateAgent("legacy-uuid", updates("name", "new-name"));

        JsonObject saved = savedAgent(agentPath, "legacy-uuid");
        assertEquals("new-name", saved.get("name").getAsString());
        // Untouched legacy fields must survive an unrelated update.
        assertEquals("old prompt", saved.get("prompt").getAsString());
        assertEquals(100L, saved.get("createdAt").getAsLong());
        // Discovery metadata is added to the in-memory view only, never persisted.
        assertEquals(Set.of("id", "name", "prompt", "createdAt"), saved.keySet());
    }

    // ------------------------------------------------------------------
    // Full specification field set
    // ------------------------------------------------------------------

    @Test
    public void shouldReadFullSpecificationEntryWithoutLoss() throws Exception {
        String full = """
                {
                  "agents": {
                    "full-agent": {
                      "id": "full-agent",
                      "name": "spec-agent",
                      "description": "Use when verifying the specification contract.",
                      "prompt": "Body prompt.",
                      "createdAt": 1700000000000,
                      "tools": ["Read", "Grep", "Bash"],
                      "disallowedTools": ["Write", "Edit"],
                      "model": "sonnet",
                      "permissionMode": "acceptEdits",
                      "maxTurns": 20,
                      "skills": ["workflow-patterns"],
                      "mcpServers": ["slack"],
                      "hooks": {"PreToolUse": []},
                      "memory": "project",
                      "background": true,
                      "effort": "high",
                      "isolation": "worktree",
                      "color": "blue",
                      "initialPrompt": "Start here.",
                      "omitClaudeMd": true,
                      "experimental": {"cacheTtl": "5m"},
                      "createdAtSource": "ignored"
                    }
                  }
                }
                """;
        Path agentPath = writeConfig(full);
        AgentManager manager = newManager(agentPath);

        JsonObject agent = manager.getAgent("full-agent");

        assertNotNull(agent);
        for (String field : AgentFields.SPECIFICATION_FIELDS) {
            assertTrue("full entry must expose '" + field + "'", agent.has(field));
        }
        assertEquals("spec-agent", agent.get("name").getAsString());
        assertEquals(20, agent.get("maxTurns").getAsInt());
        assertTrue(agent.get("background").getAsBoolean());
        assertTrue(agent.get("omitClaudeMd").getAsBoolean());
        assertEquals("worktree", agent.get("isolation").getAsString());
        assertEquals("5m", agent.getAsJsonObject("experimental").get("cacheTtl").getAsString());
    }

    @Test
    public void shouldRoundTripFullSpecificationEntryUnchanged() throws Exception {
        Path agentPath = writeConfig("""
                {
                  "agents": {
                    "full-agent": {
                      "id": "full-agent",
                      "name": "spec-agent",
                      "description": "desc",
                      "prompt": "body",
                      "createdAt": 1700000000000,
                      "tools": ["Read"],
                      "disallowedTools": ["Write"],
                      "model": "opus",
                      "permissionMode": "plan",
                      "maxTurns": 5,
                      "skills": ["a"],
                      "mcpServers": ["b"],
                      "hooks": {"Stop": []},
                      "memory": "user",
                      "background": false,
                      "effort": "low",
                      "isolation": "worktree",
                      "color": "green",
                      "initialPrompt": "go",
                      "omitClaudeMd": false,
                      "experimental": {"cacheTtl": "1h"}
                    }
                  }
                }
                """);
        AgentManager manager = newManager(agentPath);

        JsonObject before = manager.getAgent("full-agent");
        manager.updateAgent("full-agent", new JsonObject());
        JsonObject after = savedAgent(agentPath, "full-agent");

        assertEquals(before, after);
    }

    @Test
    public void shouldRejectSpecificationEntryMissingRequiredName() {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "x");
        agent.addProperty("description", "no name here");

        assertEquals("Missing required field: name", newManager().validateAgent(agent));
    }

    // ------------------------------------------------------------------
    // Unknown fields written by a newer Claude Code / plugin
    // ------------------------------------------------------------------

    @Test
    public void shouldTolerateAndPreserveUnknownFields() throws Exception {
        Path agentPath = writeConfig("""
                {
                  "agents": {
                    "future-agent": {
                      "id": "future-agent",
                      "name": "future-agent",
                      "prompt": "body",
                      "createdAt": 1,
                      "someBrandNewField": {"nested": [1, 2, 3]},
                      "anotherUnknown": "value"
                    }
                  }
                }
                """);
        AgentManager manager = newManager(agentPath);

        JsonObject agent = manager.getAgent("future-agent");
        assertNotNull(agent);
        assertTrue(agent.has("someBrandNewField"));
        assertEquals("value", agent.get("anotherUnknown").getAsString());

        // Saving an unrelated change must not drop fields we do not understand.
        manager.updateAgent("future-agent", updates("prompt", "new body"));

        JsonObject saved = savedAgent(agentPath, "future-agent");
        assertTrue("unknown field must survive a save", saved.has("someBrandNewField"));
        assertEquals(3, saved.getAsJsonObject("someBrandNewField").getAsJsonArray("nested").size());
        assertEquals("value", saved.get("anotherUnknown").getAsString());
        assertEquals("new body", saved.get("prompt").getAsString());
    }

    @Test
    public void shouldAcceptUnknownSpecificationFieldsOnImport() {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "imported");
        agent.addProperty("name", "imported");
        agent.addProperty("unknownField", "whatever");

        assertNull(newManager().validateAgent(agent));
    }

    // ------------------------------------------------------------------
    // Name length: the 20-character cap is gone (task 56, owner decision)
    // ------------------------------------------------------------------

    @Test
    public void shouldAcceptNameLongerThanTwentyCharacters() {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "long");
        agent.addProperty("name", "seo-cannibalization-detector");

        assertEquals(28, "seo-cannibalization-detector".length());
        assertNull(newManager().validateAgent(agent));
    }

    @Test
    public void shouldAcceptRealWorldLongAgentNames() {
        // Real names from ~/.claude/agents that the old 1-20 rule rejected.
        // Every name below is longer than 20 characters, verified by the assert.
        List<String> longNames = List.of(
                "seo-cannibalization-detector",
                "microinteraction-patterns",
                "vector-database-engineer",
                "event-sourcing-architect",
                "seo-structure-architect",
                "migration-observability",
                "frontend-security-coder",
                "codebase-memory-auditor");

        for (String name : longNames) {
            assertTrue(name + " must be longer than the removed 20-char cap",
                    name.length() > 20);
            JsonObject agent = new JsonObject();
            agent.addProperty("id", name);
            agent.addProperty("name", name);
            assertNull(name + " must validate", newManager().validateAgent(agent));
        }
    }

    @Test
    public void shouldStillRejectEmptyName() {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "x");
        agent.addProperty("name", "   ");

        assertNotNull(newManager().validateAgent(agent));
    }

    // ------------------------------------------------------------------
    // Names with spaces / special characters: deliberate, not silent
    // ------------------------------------------------------------------

    @Test
    public void shouldRejectNameWithReservedColon() {
        // The specification reserves ':' for plugin-scoped ids ("my-plugin:reviewer")
        // and Claude Code refuses to load such a file.
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "x");
        agent.addProperty("name", "my-plugin:reviewer");

        String error = newManager().validateAgent(agent);

        assertNotNull(error);
        assertTrue(error, error.contains(":"));
    }

    @Test
    public void shouldAcceptNameWithSpacesAsWarning() {
        // A space is legal in a display name. Legacy store entries legitimately
        // contain them ("New Agent"), so rejecting them would be a regression.
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "x");
        agent.addProperty("name", "New Agent");

        assertNull("spaces must remain valid for backward compatibility",
                newManager().validateAgent(agent));
        assertTrue("spaces must be flagged as a non-hyphen-case warning",
                AgentFields.isNonHyphenCaseName("New Agent"));
        assertFalse(AgentFields.isNonHyphenCaseName("java-pro"));
    }

    @Test
    public void shouldAcceptNonHyphenCaseNamesWithWarning() {
        // Names that are not hyphen-case are still valid identifiers; they are
        // surfaced as a warning rather than dropped.
        assertTrue(AgentFields.isNonHyphenCaseName("Java Pro"));
        assertTrue(AgentFields.isNonHyphenCaseName("java_pro"));
        assertTrue(AgentFields.isNonHyphenCaseName("JavaPro"));
        assertFalse(AgentFields.isNonHyphenCaseName("java-pro"));
        assertFalse(AgentFields.isNonHyphenCaseName("v2"));
        assertFalse(AgentFields.isNonHyphenCaseName("reviewer-v2"));
    }

    @Test
    public void shouldSanitizeNameForUseAsId() {
        assertEquals("java-pro", AgentFields.toIdSegment("java-pro"));
        assertEquals("Java-Pro", AgentFields.toIdSegment("Java-Pro"));
        assertEquals("java-pro", AgentFields.toIdSegment("java pro"));
        assertEquals("seo-cannibalization-detector",
                AgentFields.toIdSegment("seo-cannibalization-detector"));
    }

    // ------------------------------------------------------------------
    // Prompt cap stays (unrelated to the name cap)
    // ------------------------------------------------------------------

    @Test
    public void shouldStillRejectOversizedPrompt() {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "x");
        agent.addProperty("name", "ok-name");
        agent.addProperty("prompt", "a".repeat(100_001));

        assertEquals("Agent prompt must be less than 100,000 characters",
                newManager().validateAgent(agent));
    }

    // ------------------------------------------------------------------
    // Discovery metadata
    // ------------------------------------------------------------------

    @Test
    public void shouldRecognizeAllDiscoveryScopes() {
        assertEquals("global", AgentFields.SCOPE_GLOBAL);
        assertEquals("local", AgentFields.SCOPE_LOCAL);
        assertEquals("store", AgentFields.SCOPE_STORE);
        assertTrue(AgentFields.isDiscoveryScope(AgentFields.SCOPE_GLOBAL));
        assertTrue(AgentFields.isDiscoveryScope(AgentFields.SCOPE_LOCAL));
        assertTrue(AgentFields.isDiscoveryScope(AgentFields.SCOPE_STORE));
        assertFalse(AgentFields.isDiscoveryScope("project"));
    }

    @Test
    public void shouldSerializeDiscoveryMetadataForStoreEntry() throws Exception {
        Path agentPath = writeConfig("{\"agents\":{}}");
        AgentManager manager = newManager(agentPath);

        JsonObject agent = new JsonObject();
        agent.addProperty("id", "store-agent");
        agent.addProperty("name", "store-agent");
        agent.addProperty("scope", AgentFields.SCOPE_STORE);
        agent.addProperty("source", "store");
        agent.addProperty("readOnly", false);
        manager.addAgent(agent);

        JsonObject saved = savedAgent(agentPath, "store-agent");
        assertEquals("store", saved.get("scope").getAsString());
        assertEquals("store", saved.get("source").getAsString());
        assertFalse(saved.get("readOnly").getAsBoolean());
        assertFalse("no file path for a store entry", saved.has("path"));
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private JsonObject updates(String key, String value) {
        JsonObject updates = new JsonObject();
        updates.addProperty(key, value);
        return updates;
    }

    private Path writeConfig(String content) throws IOException {
        Path agentPath = temp.newFile("agent.json").toPath();
        Files.writeString(agentPath, content, StandardCharsets.UTF_8);
        return agentPath;
    }

    private JsonObject savedAgent(Path agentPath, String id) throws IOException {
        return JsonParser.parseString(Files.readString(agentPath, StandardCharsets.UTF_8))
                .getAsJsonObject()
                .getAsJsonObject("agents")
                .getAsJsonObject(id);
    }

    private AgentManager newManager() {
        return newManager(temp.getRoot().toPath().resolve("unused-agent.json"));
    }

    private AgentManager newManager(Path agentPath) {
        return new AgentManager(new Gson(), new TestConfigPathManager(agentPath));
    }

    private static final class TestConfigPathManager extends ConfigPathManager {
        private final Path agentPath;

        private TestConfigPathManager(Path agentPath) {
            this.agentPath = agentPath;
        }

        @Override
        public Path getAgentFilePath() {
            return agentPath;
        }

        @Override
        public void ensureConfigDirectory() throws IOException {
            Files.createDirectories(agentPath.getParent());
        }
    }
}
