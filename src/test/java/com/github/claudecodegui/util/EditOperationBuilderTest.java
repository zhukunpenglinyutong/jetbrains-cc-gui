package com.github.claudecodegui.util;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class EditOperationBuilderTest {

    @Test
    public void buildsSingleEditForModifiedText() {
        List<EditOperationBuilder.Operation> operations = EditOperationBuilder.build("/tmp/File.java", true, "one\ntwo\n", "one\nthree\n");

        assertEquals(1, operations.size());
        EditOperationBuilder.Operation operation = operations.get(0);
        assertEquals("edit", operation.toolName());
        assertTrue(operation.oldString().contains("two"));
        assertTrue(operation.newString().contains("three"));
        assertEquals(1, operation.lineStart());
    }

    @Test
    public void buildsWriteForNewTextFile() {
        List<EditOperationBuilder.Operation> operations = EditOperationBuilder.build("/tmp/New.java", false, "", "class New {}\n");

        assertEquals(1, operations.size());
        EditOperationBuilder.Operation operation = operations.get(0);
        assertEquals("write", operation.toolName());
        assertEquals("", operation.oldString());
        assertEquals("class New {}\n", operation.newString());
        assertTrue(operation.safeToRollback());
    }

    @Test
    public void returnsEmptyWhenContentDidNotChange() {
        assertTrue(EditOperationBuilder.build("/tmp/File.java", true, "same", "same").isEmpty());
    }

    @Test
    public void skipsBinaryContent() {
        List<EditOperationBuilder.Operation> operations = EditOperationBuilder.build("/tmp/File.bin", true, "a\u0000b", "a\u0000c");
        assertTrue(operations.isEmpty());
    }

    @Test
    public void lineStartPointsToContextHunkStartForSafeRollback() {
        String before = "a\nb\nc\nd\ne\n";
        String after = "a\nb\nchanged\nd\ne\n";

        EditOperationBuilder.Operation operation = EditOperationBuilder.build("/tmp/File.java", true, before, after).get(0);

        assertTrue(operation.newString().startsWith("a\nb\n"));
        assertEquals(1, operation.lineStart());
    }


    @Test
    public void buildsSeparateOperationsForDistantHunks() {
        String before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
        String after = "a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n";

        List<EditOperationBuilder.Operation> operations = EditOperationBuilder.build("/tmp/File.java", true, before, after);

        assertEquals(2, operations.size());
        assertTrue(operations.get(0).newString().contains("B"));
        assertFalse(operations.get(0).newString().contains("F"));
        assertTrue(operations.get(1).newString().contains("I"));
        assertFalse(operations.get(1).newString().contains("B"));
    }



    @Test
    public void marksEmptyAfterContentUnsafe() {
        List<EditOperationBuilder.Operation> operations = EditOperationBuilder.build("/tmp/File.java", true, "old content", "");

        assertEquals(1, operations.size());
        EditOperationBuilder.Operation operation = operations.get(0);
        assertEquals("", operation.newString());
        assertFalse(operation.safeToRollback());
    }

}
