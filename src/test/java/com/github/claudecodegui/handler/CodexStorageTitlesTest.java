package com.github.claudecodegui.handler;

import org.junit.Test;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexStorageTitlesTest {
    @Test
    public void titlesAreReloadedFromTheHistoryMetadataServiceForEachRequest() {
        AtomicInteger calls = new AtomicInteger();
        NodeJsServiceCaller caller = new NodeJsServiceCaller(null) {
            @Override
            public String callNodeJsTitlesService(String functionName) {
                assertEquals("loadTitles", functionName);
                return "{\"session-1\":{\"customTitle\":\"Pet studio " + calls.incrementAndGet() + "\",\"updatedAt\":1000}}";
            }
        };

        assertEquals(Map.of("session-1", "Pet studio 1"), CodexStorageHandler.loadSessionTitles(caller));
        assertEquals(Map.of("session-1", "Pet studio 2"), CodexStorageHandler.loadSessionTitles(caller));
        assertEquals(2, calls.get());
    }

    @Test
    public void malformedEntriesDoNotHideValidTitlesOrTurnMetadataIntoDisplayNames() {
        String data = "{\"valid\":{\"customTitle\":\"Pet 工作室\",\"updatedAt\":1000},"
                + "\"blank\":{\"customTitle\":\"  \"},\"missing\":{\"updatedAt\":1000},\"null\":null,"
                + "\"string\":\"not a title entry\",\"number\":{\"customTitle\":123},\"array\":{\"customTitle\":[]}}";

        assertEquals(Map.of("valid", "Pet 工作室"), CodexStorageHandler.loadSessionTitles(callerReturning(data)));
    }

    @Test
    public void unavailableMetadataFallsBackWithoutFailingTheStorageList() {
        for (String data : List.of("{}", "[]", "null", "true", "invalid")) {
            assertTrue(CodexStorageHandler.loadSessionTitles(callerReturning(data)).isEmpty());
        }
        NodeJsServiceCaller unavailable = new NodeJsServiceCaller(null) {
            @Override
            public String callNodeJsTitlesService(String functionName) throws Exception {
                throw new IOException("Fixture metadata service unavailable");
            }
        };
        assertTrue(CodexStorageHandler.loadSessionTitles(unavailable).isEmpty());
    }

    @Test
    public void interruptedMetadataReadPreservesTheThreadInterrupt() {
        NodeJsServiceCaller interrupted = new NodeJsServiceCaller(null) {
            @Override
            public String callNodeJsTitlesService(String functionName) throws Exception {
                throw new InterruptedException("Fixture cancellation");
            }
        };
        try {
            assertTrue(CodexStorageHandler.loadSessionTitles(interrupted).isEmpty());
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
    }

    private static NodeJsServiceCaller callerReturning(String data) {
        return new NodeJsServiceCaller(null) {
            @Override
            public String callNodeJsTitlesService(String functionName) {
                return data;
            }
        };
    }
}
