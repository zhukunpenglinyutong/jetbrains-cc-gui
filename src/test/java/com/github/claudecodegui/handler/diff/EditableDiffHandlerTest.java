package com.github.claudecodegui.handler.diff;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class EditableDiffHandlerTest {

    @Test
    public void operationsAreUnsafeWhenAnyOperationDisallowsRollback() {
        JsonArray operations = new JsonArray();
        operations.add(operation(true));
        operations.add(operation(false));

        assertFalse(EditableDiffHandler.areOperationsSafeToRollback(operations));
    }

    @Test
    public void operationsAreSafeWhenSafetyFlagIsMissingOrTrue() {
        JsonArray operations = new JsonArray();
        operations.add(operation(true));
        JsonObject missingFlag = new JsonObject();
        missingFlag.addProperty("newString", "content");
        operations.add(missingFlag);

        assertTrue(EditableDiffHandler.areOperationsSafeToRollback(operations));
    }

    private static JsonObject operation(boolean safe) {
        JsonObject operation = new JsonObject();
        operation.addProperty("newString", "content");
        operation.addProperty("safeToRollback", safe);
        return operation;
    }
}
