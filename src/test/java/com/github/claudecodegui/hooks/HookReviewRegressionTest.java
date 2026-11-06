package com.github.claudecodegui.hooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

/** Regression coverage for shared edits and independently restored Claude hooks. */
public class HookReviewRegressionTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();
    private static final String ORIGINAL = "{\"hooks\":{\"Stop\":[{\"matcher\":\"Bash\",\"custom\":17,"
            + "\"hooks\":[{\"type\":\"command\",\"command\":\"echo ready\"}]}]},\"other\":null}";

    @Test public void externalRestoreDoesNotDuplicateTheDisabledHandler() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        HookCatalogService catalog = new HookCatalogService(home);
        HookToggleService service = new HookToggleService(home);
        assertTrue(service.toggle(null, request(item(catalog, false), false)).get("success").getAsBoolean());
        Files.writeString(source, ORIGINAL);
        JsonObject result = service.toggle(null, request(item(catalog, true), true));
        assertTrue(result.toString(), result.get("success").getAsBoolean());
        assertEquals(ORIGINAL, Files.readString(source));
        assertEquals(1, catalog.scan(null).getAsJsonArray("items").size());
    }

    @Test public void removingAnEmptyGroupPreservesItsMetadataForRestore() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        HookCatalogService catalog = new HookCatalogService(home);
        HookToggleService service = new HookToggleService(home);
        assertTrue(service.toggle(null, request(item(catalog, false), false)).get("success").getAsBoolean());
        assertEquals(0, JsonParser.parseString(Files.readString(source)).getAsJsonObject().getAsJsonObject("hooks").getAsJsonArray("Stop").size());
        assertTrue(service.toggle(null, request(item(catalog, true), true)).get("success").getAsBoolean());
        assertEquals(JsonParser.parseString(ORIGINAL), JsonParser.parseString(Files.readString(source)));
    }

    @Test public void disabledRecordsRemainVisibleForMissingOrMalformedSources() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        HookCatalogService catalog = new HookCatalogService(home);
        assertTrue(new HookToggleService(home).toggle(null, request(item(catalog, false), false)).get("success").getAsBoolean());
        Files.delete(source);
        JsonObject missing = item(catalog, true);
        assertFalse(missing.get("managedToggleSupported").getAsBoolean());
        assertFalse(missing.get("editSupported").getAsBoolean());
        for (String invalid : new String[] {"not-json", "[]", "{\"hooks\":17}"}) {
            Files.writeString(source, invalid);
            JsonObject disabled = item(catalog, true);
            assertFalse(disabled.get("managedToggleSupported").getAsBoolean());
        }
    }

    @Test public void changedEventShapeCannotDiscardThePrivateRecoveryEntry() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        HookCatalogService catalog = new HookCatalogService(home);
        HookToggleService service = new HookToggleService(home);
        assertTrue(service.toggle(null, request(item(catalog, false), false)).get("success").getAsBoolean());
        Files.writeString(source, "{\"hooks\":{\"Stop\":17}}");
        JsonObject result = service.toggle(null, request(item(catalog, true), true));
        assertFalse(result.get("success").getAsBoolean());
        assertEquals("HOOK_RESTORE_CONFLICT", result.get("errorCode").getAsString());
        assertNotNull(item(catalog, true));
        assertEquals("{\"hooks\":{\"Stop\":17}}", Files.readString(source));
    }

    @Test public void sharedProjectToggleNeedsExplicitConfirmationEvenWithSpoofedScope() throws Exception {
        Path home = temporary.newFolder("home").toPath();
        Path project = temporary.newFolder("project").toPath();
        Path source = settings(project, ORIGINAL);
        JsonObject item = new HookCatalogService(home).scan(project.toString()).getAsJsonArray("items").get(0).getAsJsonObject();
        JsonObject request = request(item, false);
        request.addProperty("scope", "GLOBAL");
        HookToggleService service = new HookToggleService(home);
        JsonObject rejected = service.toggle(project.toString(), request);
        assertFalse(rejected.get("success").getAsBoolean());
        assertEquals("HOOK_SHARED_CONFIRMATION_REQUIRED", rejected.get("errorCode").getAsString());
        assertEquals(ORIGINAL, Files.readString(source));
        request.addProperty("confirmSharedChange", true);
        assertTrue(service.toggle(project.toString(), request).get("success").getAsBoolean());
    }

    @Test public void unsupportedScriptsAndLegacyStateAreNotManaged() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        Path script = Files.createDirectories(home.resolve(".codemoss/hooks")).resolve("before.sh");
        Files.writeString(script, "echo fixture");
        Files.writeString(source.getParent().resolve(".ccgui-hooks-state.json"), "not-json");
        HookCatalogService catalog = new HookCatalogService(home);
        assertEquals(1, catalog.scan(null).getAsJsonArray("items").size());
        assertTrue(new HookToggleService(home).toggle(null, request(item(catalog, false), false)).get("success").getAsBoolean());
        assertEquals("not-json", Files.readString(source.getParent().resolve(".ccgui-hooks-state.json")));
        assertFalse(new HookMutationService(home).read(null, script.toString()).get("success").getAsBoolean());
    }

    @Test public void linkedSourceFilesAdvertiseTheSameReadOnlyBoundaryAsWrites() throws Exception {
        Path home = temporary.getRoot().toPath();
        Path source = settings(home, ORIGINAL);
        Path original = source.resolveSibling("original.json");
        Files.move(source, original);
        try {
            Files.createSymbolicLink(source, original);
        } catch (java.io.IOException | UnsupportedOperationException | SecurityException unavailable) {
            org.junit.Assume.assumeNoException(unavailable);
        }
        JsonObject item = item(new HookCatalogService(home), false);
        assertFalse(item.get("editSupported").getAsBoolean());
        assertFalse(item.get("managedToggleSupported").getAsBoolean());
        assertEquals("LINKED_SOURCE_READ_ONLY", item.get("readOnlyReason").getAsString());
    }

    @Test public void removingMultipleGroupsPreservesBothGroupAndHandlerOrder() throws Exception {
        for (String restoreOrder : new String[] {"ACBD", "DCBA", "BADC"}) {
            Path home = temporary.newFolder().toPath();
            String original = "{\"hooks\":{\"Stop\":[{\"matcher\":\"Bash\",\"custom\":1,\"hooks\":["
                    + "{\"type\":\"command\",\"command\":\"A\"},{\"type\":\"command\",\"command\":\"B\"}]},"
                    + "{\"matcher\":\"Read\",\"custom\":2,\"hooks\":[{\"type\":\"command\",\"command\":\"C\"}]},"
                    + "{\"type\":\"command\",\"command\":\"D\"}]}}";
            Path source = settings(home, original);
            HookCatalogService catalog = new HookCatalogService(home);
            HookToggleService service = new HookToggleService(home);
            for (char command : "ABCD".toCharArray()) {
                JsonObject item = command(catalog, command);
                assertTrue(service.toggle(null, request(item, false)).get("success").getAsBoolean());
            }
            for (char command : restoreOrder.toCharArray()) {
                JsonObject item = command(catalog, command);
                JsonObject result = service.toggle(null, request(item, true));
                assertTrue(result.toString(), result.get("success").getAsBoolean());
            }
            assertEquals(restoreOrder, JsonParser.parseString(original), JsonParser.parseString(Files.readString(source)));
        }
    }

    private static JsonObject command(HookCatalogService catalog, char command) {
        for (var value : catalog.scan(null).getAsJsonArray("items")) {
            if (String.valueOf(command).equals(value.getAsJsonObject().get("command").getAsString())) {
                return value.getAsJsonObject();
            }
        }
        throw new AssertionError("Missing command " + command);
    }

    private static Path settings(Path root, String value) throws Exception {
        Path source = Files.createDirectories(root.resolve(".claude")).resolve("settings.json");
        Files.writeString(source, value);
        return source;
    }

    private static JsonObject item(HookCatalogService catalog, boolean disabled) {
        JsonArray items = catalog.scan(null).getAsJsonArray("items");
        for (var value : items) {
            JsonObject item = value.getAsJsonObject();
            if (item.get("enabled").getAsBoolean() != disabled) {
                return item;
            }
        }
        throw new AssertionError("Expected " + (disabled ? "disabled" : "active") + " fixture");
    }

    private static JsonObject request(JsonObject item, boolean enabled) {
        JsonObject request = new JsonObject();
        for (String field : new String[] {"provider", "scope", "event", "sourceId", "format", "managedKey"}) {
            if (item.has(field)) { request.add(field, item.get(field)); }
        }
        request.add("location", item.get("rawLocation"));
        request.add("expectedRevision", item.get("revision"));
        request.addProperty("enabled", enabled);
        request.addProperty("requestId", "review-regression");
        return request;
    }
}
