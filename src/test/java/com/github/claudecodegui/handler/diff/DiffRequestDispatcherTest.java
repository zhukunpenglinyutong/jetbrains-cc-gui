package com.github.claudecodegui.handler.diff;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class DiffRequestDispatcherTest {

    @Test
    public void dispatchesToMatchingHandler() {
        RecordingHandler refreshHandler = new RecordingHandler("refresh_file");
        RecordingHandler diffHandler = new RecordingHandler("show_diff", "show_multi_edit_diff");
        DiffRequestDispatcher dispatcher = new DiffRequestDispatcher(List.of(refreshHandler, diffHandler));

        boolean handled = dispatcher.dispatch("show_multi_edit_diff", "{\"filePath\":\"demo.txt\"}");

        assertTrue(handled);
        assertEquals(0, refreshHandler.invocationCount);
        assertEquals(1, diffHandler.invocationCount);
        assertEquals("show_multi_edit_diff", diffHandler.lastType);
        assertEquals("{\"filePath\":\"demo.txt\"}", diffHandler.lastContent);
    }

    @Test
    public void returnsFalseWhenNoHandlerSupportsType() {
        DiffRequestDispatcher dispatcher = new DiffRequestDispatcher(List.of(new RecordingHandler("refresh_file")));

        boolean handled = dispatcher.dispatch("unknown_type", "{}");

        assertFalse(handled);
    }

    @Test
    public void getAllSupportedTypesAggregatesFromAllHandlers() {
        RecordingHandler handler1 = new RecordingHandler("refresh_file");
        RecordingHandler handler2 = new RecordingHandler("show_diff", "show_multi_edit_diff");
        DiffRequestDispatcher dispatcher = new DiffRequestDispatcher(List.of(handler1, handler2));

        String[] types = dispatcher.getAllSupportedTypes();

        assertEquals(3, types.length);
        assertEquals("refresh_file", types[0]);
        assertEquals("show_diff", types[1]);
        assertEquals("show_multi_edit_diff", types[2]);
    }

    private static final class RecordingHandler implements DiffActionHandler {
        private final String[] supportedTypes;
        private int invocationCount;
        private String lastType;
        private String lastContent;

        private RecordingHandler(String... supportedTypes) {
            this.supportedTypes = supportedTypes;
        }

        @Override
        public String[] getSupportedTypes() {
            return supportedTypes;
        }

        @Override
        public void handle(String type, String content) {
            invocationCount++;
            lastType = type;
            lastContent = content;
        }
    }
}
