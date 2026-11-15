package com.github.claudecodegui.provider.dsh;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class DshCliBridgeInterruptTest {

    private static final class RecordingBridge extends DshCliBridge {
        final List<String> cancelled = new ArrayList<>();

        @Override
        void requestHostCancel(String sessionId) {
            cancelled.add(sessionId);
        }
    }

    @Test
    public void interruptAsksTheHostToCancelTheChannelsSessionBeforeKilling() {
        RecordingBridge bridge = new RecordingBridge();
        bridge.trackSession("tab-1", "dsh:abc");
        bridge.trackSession("tab-2", "other");

        bridge.interruptChannel("tab-1");

        assertEquals(List.of("dsh:abc"), bridge.cancelled);
    }

    @Test
    public void interruptWithoutAKnownSessionDoesNotContactTheHost() {
        RecordingBridge bridge = new RecordingBridge();

        bridge.interruptChannel("tab-1");
        bridge.interruptChannel(null);
        bridge.trackSession("tab-1", "  ");
        bridge.interruptChannel("tab-1");

        assertTrue(bridge.cancelled.isEmpty());
    }
}
