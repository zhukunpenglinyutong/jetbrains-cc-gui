package com.github.claudecodegui.handler.file;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
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

    @Test
    public void batchUndoRollsBackAppliedActionsWhenLaterActionFails() {
        List<String> events = new ArrayList<>();
        UndoFileHandler.BatchUndoAction first = new RecordingAction("first", events, false);
        UndoFileHandler.BatchUndoAction second = new RecordingAction("second", events, true);

        UndoFileHandler.BatchUndoExecution execution = UndoFileHandler.executeBatchUndoActions(List.of(first, second), null);

        assertFalse(execution.success());
        assertEquals(List.of("apply:first", "apply:second", "rollback:first"), events);
        assertEquals(1, execution.appliedCount());
    }

    @Test
    public void batchUndoDoesNotRollbackWhenCleanupFailsAfterAllActionsApplied() {
        List<String> events = new ArrayList<>();
        UndoFileHandler.BatchUndoAction first = new CleanupFailingAction("first", events);

        UndoFileHandler.BatchUndoExecution execution = UndoFileHandler.executeBatchUndoActions(List.of(first), null);

        assertTrue(execution.success());
        assertEquals(List.of("apply:first", "afterCommit:first"), events);
        assertEquals(1, execution.appliedCount());
    }

    private record RecordingAction(String filePath, List<String> events, boolean fail)
            implements UndoFileHandler.BatchUndoAction {
        @Override
        public void apply() throws Exception {
            events.add("apply:" + filePath);
            if (fail) {
                throw new Exception("failed:" + filePath);
            }
        }

        @Override
        public void rollback() {
            events.add("rollback:" + filePath);
        }
    }

    private record CleanupFailingAction(String filePath, List<String> events)
            implements UndoFileHandler.BatchUndoAction {
        @Override
        public void apply() {
            events.add("apply:" + filePath);
        }

        @Override
        public void rollback() {
            events.add("rollback:" + filePath);
        }

        @Override
        public void afterCommit() throws Exception {
            events.add("afterCommit:" + filePath);
            throw new Exception("cleanup failed");
        }
    }
}
