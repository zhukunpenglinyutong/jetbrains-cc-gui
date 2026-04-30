package com.github.claudecodegui.handler.diff;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SimpleDiffDisplayHandlerTest {

    @Test
    public void applyForwardEditsForPreviewFailsClosedOnAmbiguousOldString() {
        JsonArray edits = new JsonArray();
        edits.add(edit("same", "changed", false));

        SimpleDiffDisplayHandler.ForwardApplyResult result = SimpleDiffDisplayHandler.applyForwardEditsForPreview(
                "same\nother\nsame\n", edits);

        assertFalse(result.success());
        assertEquals("ambiguous_old_string", result.reason());
    }

    @Test
    public void applyForwardEditsForPreviewAppliesUniqueEdit() {
        JsonArray edits = new JsonArray();
        edits.add(edit("before", "after", false));

        SimpleDiffDisplayHandler.ForwardApplyResult result = SimpleDiffDisplayHandler.applyForwardEditsForPreview(
                "line\nbefore\n", edits);

        assertTrue(result.success());
        assertEquals("line\nafter\n", result.content());
    }

    private static JsonObject edit(String oldString, String newString, boolean replaceAll) {
        JsonObject edit = new JsonObject();
        edit.addProperty("oldString", oldString);
        edit.addProperty("newString", newString);
        edit.addProperty("replaceAll", replaceAll);
        return edit;
    }
}
