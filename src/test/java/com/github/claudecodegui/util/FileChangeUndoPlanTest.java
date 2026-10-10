package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

/** Verifies that undo rebuilds the baseline before touching the filesystem. */
public class FileChangeUndoPlanTest {
    /** Restores pure deletions at their recorded line instead of skipping them. */
    @Test
    public void restoresDeletedLinesAtTheRightPosition() {
        JsonArray ops = ops(update("@@ -2 +1,0 @@\n-removed", "removed", ""));
        assertEquals("first\nremoved\nlast\n", FileChangeUndoPlan.rebuild("file", "first\nlast\n", ops).content());
    }

    /** Reverses multiple hunks from the bottom so earlier line offsets stay valid. */
    @Test
    public void unwindsMultipleHunks() {
        JsonArray ops = ops(update("@@ -1 +1,2 @@\n-old\n+new\n+extra", "old", "new\nextra"),
                update("@@ -4 +5 @@\n-last\n+end", "last", "end"));
        assertEquals("old\na\nb\nlast\n", FileChangeUndoPlan.rebuild("file", "new\nextra\na\nb\nend\n", ops).content());
    }

    /** Uses context for raw patches without line numbers and refuses ambiguous matches. */
    @Test
    public void locatesRawHunksWithoutGuessing() {
        JsonArray ops = ops(update("@@\n anchor\n-old\n+new\n tail", "anchor\nold\ntail", "anchor\nnew\ntail"));
        assertEquals("head\nanchor\nold\ntail\n", FileChangeUndoPlan.rebuild("file", "head\nanchor\nnew\ntail\n", ops).content());
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file",
                "anchor\nnew\ntail\nanchor\nnew\ntail\n", ops));
    }

    /** Moves the baseline back through a rename and restores a deleted file. */
    @Test
    public void restoresRenameThenDeletion() {
        JsonObject moved = update("@@ -1 +1 @@\n-before\n+after", "before", "after");
        moved.addProperty("moveFrom", "original.ts");
        JsonArray ops = ops(moved, change("delete", "after\n", ""));
        FileChangeUndoPlan plan = FileChangeUndoPlan.rebuild("moved.ts", null, ops);
        assertEquals("original.ts", plan.filePath());
        assertEquals("before\n", plan.content());
    }

    /** An added then renamed file has no pre-session file to restore. */
    @Test
    public void removesAddedThenRenamedFile() {
        JsonObject moved = update("@@ -1 +1 @@\n-one\n+two", "one", "two");
        moved.addProperty("moveFrom", "original.ts");
        assertNull(FileChangeUndoPlan.rebuild("moved.ts", "two\n", ops(change("add", "", "one\n"), moved)).content());
    }

    /** Never overwrites a file whose current content no longer matches the tool outcome. */
    @Test
    public void refusesDivergedContent() {
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file", "user edit\n",
                ops(update("@@ -1 +1 @@\n-old\n+new", "old", "new"))));
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file", "user edit\n",
                ops(change("add", "", "created\n"))));
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file", "recreated\n",
                ops(change("delete", "deleted\n", ""))));
        JsonObject unknown = change("delete", "", "");
        unknown.addProperty("oldStringKnown", false);
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file", null, ops(unknown)));
    }

    /** Preserves missing final newlines instead of silently changing file bytes. */
    @Test
    public void respectsEndOfFileMarkers() {
        JsonObject op = update("@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file", "old", "new");
        assertEquals("old", FileChangeUndoPlan.rebuild("file", "new", ops(op)).content());
    }

    /** Legacy replacements fail visibly if they no longer apply. */
    @Test
    public void validatesLegacyReplacements() {
        JsonObject legacy = new JsonObject();
        legacy.addProperty("oldString", "before");
        legacy.addProperty("newString", "after");
        assertEquals("before\n", FileChangeUndoPlan.rebuild("file", "after\n", ops(legacy)).content());
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file", "different\n", ops(legacy)));
    }

    /** A patch-less replacement refuses to guess between duplicate occurrences. */
    @Test
    public void refusesAmbiguousLegacyReplacement() {
        JsonObject legacy = change("update", "old", "new");
        legacy.remove("patch");
        assertThrows(IllegalArgumentException.class, () -> FileChangeUndoPlan.rebuild("file",
                "new\nkeep\nnew\n", ops(legacy)));
        JsonObject replaceAll = change("update", "old", "new");
        replaceAll.addProperty("replaceAll", true);
        assertEquals("old\nkeep\nold\n", FileChangeUndoPlan.rebuild("file", "new\nkeep\nnew\n", ops(replaceAll)).content());
    }

    private static JsonArray ops(JsonObject... operations) {
        JsonArray result = new JsonArray();
        for (JsonObject operation : operations) result.add(operation);
        return result;
    }

    private static JsonObject update(String patch, String before, String after) {
        JsonObject op = change("update", before, after);
        op.addProperty("patch", patch);
        return op;
    }

    private static JsonObject change(String kind, String before, String after) {
        JsonObject op = new JsonObject();
        op.addProperty("fileChangeKind", kind);
        op.addProperty("oldString", before);
        op.addProperty("newString", after);
        return op;
    }
}
