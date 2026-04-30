package com.github.claudecodegui.handler.file;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class UndoFileHandlerTest {

    @Test
    public void detectsUnsafeSnakeCaseRollbackOperation() {
        JsonArray operations = new JsonArray();
        JsonObject operation = new JsonObject();
        operation.addProperty("safe_to_rollback", false);
        operations.add(operation);

        assertTrue(UndoFileHandler.hasUnsafeOperation(operations));
    }

    @Test
    public void detectsUnsafeCamelCaseRollbackOperation() {
        JsonArray operations = new JsonArray();
        JsonObject operation = new JsonObject();
        operation.addProperty("safeToRollback", false);
        operations.add(operation);

        assertTrue(UndoFileHandler.hasUnsafeOperation(operations));
    }

    @Test
    public void missingRollbackSafetyFlagDefaultsToSafeForLegacyRequests() {
        JsonArray operations = new JsonArray();
        operations.add(new JsonObject());

        assertFalse(UndoFileHandler.hasUnsafeOperation(operations));
        assertFalse(UndoFileHandler.hasUnsafeOperation(null));
    }
}
