package com.github.claudecodegui.storage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.*;

public class CodexStorageLineageTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void relationshipsUseSavedTitlesOutsideTheCurrentPageAndArchiveFilter() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.rollout("parent", null, false);
        f.rollout("child", "parent", true);
        f.rollout("sibling", "parent", false);
        var inventory = new CodexStorageInventory(f.paths, Map.of("parent", "Renamed main session"));

        JsonObject child = only(inventory.listPage(1, 1, "child", "recent", "archived"));
        assertTrue(child.get("subagent").getAsBoolean());
        assertEquals("parent", child.get("parentId").getAsString());
        assertEquals("Renamed main session", child.get("parentTitle").getAsString());
        assertTrue(child.get("parentAvailable").getAsBoolean());
        assertFalse(child.get("parentIsSubagent").getAsBoolean());
        JsonObject parent = only(inventory.listPage(1, 1, "Renamed", "size", "all"));
        assertFalse(parent.get("subagent").getAsBoolean());
        assertEquals(2, parent.get("childCount").getAsInt());
        assertFalse(parent.has("parentId"));
    }

    @Test public void nestedSubagentsKeepTheirImmediateParentAndDirectChildCounts() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.rollout("root", null, false);
        f.rollout("child", "root", false);
        f.rollout("grandchild", "child", false);
        var inventory = new CodexStorageInventory(f.paths);
        assertEquals(1, only(inventory.listPage(1, 10, "root", "recent", "all")).get("childCount").getAsInt());
        JsonObject grandchild = only(inventory.listPage(1, 10, "grandchild", "recent", "all"));
        assertEquals("child", grandchild.get("parentId").getAsString());
        assertTrue(grandchild.get("parentIsSubagent").getAsBoolean());
        assertEquals(0, grandchild.get("childCount").getAsInt());
    }

    @Test public void missingAndDatabaseOnlyParentsRetainIdentityWithoutInventingFiles() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("db-parent", "/parent", 10);
        f.rollout("db-child", "db-parent", false);
        f.rollout("orphan", "missing-parent", true);
        var inventory = new CodexStorageInventory(f.paths);
        JsonObject child = only(inventory.listPage(1, 10, "db-child", "recent", "all"));
        assertEquals("Title db-parent", child.get("parentTitle").getAsString());
        assertFalse(child.get("parentAvailable").getAsBoolean());
        JsonObject orphan = only(inventory.listPage(1, 10, "orphan", "recent", "all"));
        assertEquals("missing-parent", orphan.get("parentId").getAsString());
        assertFalse(orphan.get("parentAvailable").getAsBoolean());
        assertFalse(orphan.has("parentTitle"));
        assertEquals(2, inventory.listPage(1, 10, "", "recent", "all").get("total").getAsInt());
    }

    @Test public void nativeStateEdgesWinOverHeadersAndDoNotCountDatabaseOnlyChildren() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("parent", "/parent", 10);
        f.thread("child", "/child", 10);
        f.thread("db-only", "/child", 10);
        f.sql("state_5.sqlite", "INSERT INTO thread_spawn_edges VALUES('parent','child','completed'),('parent','db-only','completed')");
        f.rollout("parent", null, false);
        f.rollout("child", "outdated-parent", false);
        var inventory = new CodexStorageInventory(f.paths);
        JsonObject child = only(inventory.listPage(1, 10, "Title child", "recent", "all"));
        assertEquals("parent", child.get("parentId").getAsString());
        assertTrue(child.get("subagent").getAsBoolean());
        assertEquals(1, only(inventory.listPage(1, 10, "Title parent", "recent", "all")).get("childCount").getAsInt());
    }

    @Test public void metadataOnlySubagentsAndDirectParentHeadersAreRecognizedWithoutTitleGuessing() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        rewrite(f.rollout("direct-child", null, false), "{\"parent_thread_id\":\"root\"}");
        rewrite(f.rollout("unknown-parent", null, false), "{\"source\":{\"subagent\":\"review\"}}");
        f.rollout("ordinary", null, false);
        var inventory = new CodexStorageInventory(f.paths, Map.of("ordinary", "Subagent review title"));
        assertEquals("root", only(inventory.listPage(1, 10, "direct-child", "recent", "all")).get("parentId").getAsString());
        JsonObject unknown = only(inventory.listPage(1, 10, "unknown-parent", "recent", "all"));
        assertTrue(unknown.get("subagent").getAsBoolean());
        assertFalse(unknown.has("parentId"));
        assertFalse(only(inventory.listPage(1, 10, "ordinary", "recent", "all")).get("subagent").getAsBoolean());
    }

    @Test public void duplicateArchivedHeadersCannotEraseParentageOrDoubleCountAChild() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.rollout("parent", null, false);
        f.rollout("child", "parent", false);
        f.rollout("child", null, true);
        var inventory = new CodexStorageInventory(f.paths);
        assertEquals("parent", inventory.snapshot().sessions().get("child").parentId);
        assertEquals(1, only(inventory.listPage(1, 10, "parent", "recent", "all")).get("childCount").getAsInt());
    }

    @Test public void selfReferencesAreNotPresentedAsParentChildRelationships() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.rollout("self", "self", false);
        JsonObject row = only(new CodexStorageInventory(f.paths).listPage(1, 10, "", "recent", "all"));
        assertFalse(row.has("parentId"));
        assertEquals(0, row.get("childCount").getAsInt());
        assertTrue(row.get("subagent").getAsBoolean());
    }

    private static JsonObject only(JsonObject page) {
        assertEquals(1, page.getAsJsonArray("sessions").size());
        return page.getAsJsonArray("sessions").get(0).getAsJsonObject();
    }

    private static void rewrite(Path file, String metadata) throws Exception {
        JsonObject record = JsonParser.parseString(Files.readAllLines(file).get(0)).getAsJsonObject();
        JsonObject extras = JsonParser.parseString(metadata).getAsJsonObject();
        for (var field : extras.entrySet()) {
            record.getAsJsonObject("payload").add(field.getKey(), field.getValue());
        }
        Files.writeString(file, record + "\n");
    }
}
