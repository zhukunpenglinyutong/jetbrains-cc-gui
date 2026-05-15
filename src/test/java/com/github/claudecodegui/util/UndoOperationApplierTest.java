package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class UndoOperationApplierTest {

    @Test
    public void reverseEditsFailsWhenNewStringIsMissing() {
        JsonArray operations = new JsonArray();
        operations.add(operation("before", "after"));

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("current content", operations);

        assertFalse(result.isSuccess());
        assertEquals("current content", result.getContent());
        assertEquals("new_string_not_found", result.getFailures().get(0).reason());
    }

    @Test
    public void reverseEditsReplacesNewStringWithOldString() {
        JsonArray operations = new JsonArray();
        operations.add(operation("before", "after"));

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("one after two", operations);

        assertTrue(result.isSuccess());
        assertEquals("one before two", result.getContent());
    }

    @Test
    public void reverseEditsFailsForEmptyNewString() {
        JsonArray operations = new JsonArray();
        operations.add(operation("restored", ""));

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("current content", operations);

        assertFalse(result.isSuccess());
        assertEquals("empty_new_string_unsupported", result.getFailures().get(0).reason());
    }


    @Test
    public void reverseEditsFailsWhenNewStringAppearsMultipleTimesWithoutLineInfo() {
        JsonArray operations = new JsonArray();
        operations.add(operation("before", "same"));

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("same\nother\nsame", operations);

        assertFalse(result.isSuccess());
        assertEquals("ambiguous_match", result.getFailures().get(0).reason());
    }

    @Test
    public void reverseEditsUsesLineInfoToChooseUniqueNearbyMatch() {
        JsonArray operations = new JsonArray();
        JsonObject op = operation("before", "same");
        op.addProperty("lineStart", 3);
        op.addProperty("lineEnd", 3);
        operations.add(op);

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("same\nother\nsame", operations);

        assertTrue(result.isSuccess());
        assertEquals("same\nother\nbefore", result.getContent());
    }

    @Test
    public void reverseEditsFailsWhenSafeToRollbackIsFalse() {
        JsonArray operations = new JsonArray();
        JsonObject op = operation("before", "after");
        op.addProperty("safeToRollback", false);
        operations.add(op);

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("after", operations);

        assertFalse(result.isSuccess());
        assertEquals("unsafe_to_rollback", result.getFailures().get(0).reason());
    }

    @Test
    public void reverseEditsFailsWhenExpectedAfterHashDiffers() {
        JsonArray operations = new JsonArray();
        JsonObject op = operation("before", "after");
        op.addProperty("expectedAfterContentHash", "not-the-current-content-hash");
        operations.add(op);

        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits("after", operations);

        assertFalse(result.isSuccess());
        assertEquals("content_changed", result.getFailures().get(0).reason());
    }


    @Test
    public void reverseEditsUsesContextHunkLineStartToAvoidDuplicateAmbiguity() {
        JsonArray operations = new JsonArray();
        JsonObject op = operation("a\nb\nc\nd\ne\n", "a\nb\nchanged\nd\ne\n");
        op.addProperty("lineStart", 1);
        op.addProperty("lineEnd", 5);
        operations.add(op);

        String content = "a\nb\nchanged\nd\ne\n---\na\nb\nchanged\nd\ne\n";
        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits(content, operations);

        assertTrue(result.isSuccess());
        assertEquals("a\nb\nc\nd\ne\n---\na\nb\nchanged\nd\ne\n", result.getContent());
    }


    private static JsonObject operation(String oldString, String newString) {
        JsonObject op = new JsonObject();
        op.addProperty("oldString", oldString);
        op.addProperty("newString", newString);
        op.addProperty("replaceAll", false);
        return op;
    }
}
