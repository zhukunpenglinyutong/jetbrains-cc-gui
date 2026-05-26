package com.github.claudecodegui.service;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Unit tests for {@link NodeProcessInfo} DTO builder.
 */
public class NodeProcessInfoTest {

    @Test
    public void builderProducesDaemonEntryWithDefaultValues() {
        NodeProcessInfo info = NodeProcessInfo.builder()
                .kind(NodeProcessInfo.Kind.DAEMON)
                .provider("claude")
                .pid(12345L)
                .build();

        assertEquals(NodeProcessInfo.Kind.DAEMON, info.getKind());
        assertEquals("claude", info.getProvider());
        assertEquals(12345L, info.getPid());
        assertTrue("Default alive=true", info.isAlive());
        assertEquals(-1L, info.getStartedAtMs());
        assertEquals(0L, info.getUptimeMs());
        assertEquals(-1L, info.getHeapUsedBytes());
        assertEquals(0, info.getActiveRequestCount());
        assertFalse("DAEMON is not orphan", info.isOrphan());
    }

    @Test
    public void builderProducesOrphanEntryMarkedOrphan() {
        NodeProcessInfo info = NodeProcessInfo.builder()
                .kind(NodeProcessInfo.Kind.ORPHAN)
                .pid(99L)
                .command("node /path/to/daemon.js")
                .build();

        assertTrue("ORPHAN kind must be flagged isOrphan()", info.isOrphan());
        assertEquals(NodeProcessInfo.Kind.ORPHAN, info.getKind());
        assertEquals("node /path/to/daemon.js", info.getCommand());
    }

    @Test
    public void builderSynthesizesIdWhenNotProvided() {
        NodeProcessInfo info = NodeProcessInfo.builder()
                .kind(NodeProcessInfo.Kind.CHANNEL)
                .pid(777L)
                .channelId("ch-abc")
                .build();

        assertNotNull(info.getId());
        assertTrue("Synthesized id includes kind", info.getId().contains("channel"));
        assertTrue("Synthesized id includes pid", info.getId().contains("777"));
        assertTrue("Synthesized id includes channelId suffix", info.getId().contains("ch-abc"));
    }

    @Test
    public void builderUsesExplicitIdWhenProvided() {
        NodeProcessInfo info = NodeProcessInfo.builder()
                .id("custom-id")
                .kind(NodeProcessInfo.Kind.DAEMON)
                .pid(1L)
                .build();

        assertEquals("custom-id", info.getId());
    }

    @Test
    public void builderRequiresKind() {
        try {
            NodeProcessInfo.builder().pid(1L).build();
            fail("Expected IllegalStateException when kind is missing");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().toLowerCase().contains("kind"));
        }
    }

    @Test
    public void builderCarriesAllOptionalFields() {
        NodeProcessInfo info = NodeProcessInfo.builder()
                .kind(NodeProcessInfo.Kind.DAEMON)
                .provider("claude")
                .pid(100L)
                .alive(true)
                .startedAtMs(1_700_000_000_000L)
                .uptimeMs(5_000L)
                .command("node daemon.js")
                .heapUsedBytes(87_654_321L)
                .activeRequestCount(3)
                .sessionId("sess-xyz")
                .tabName("AI1")
                .build();

        assertEquals(1_700_000_000_000L, info.getStartedAtMs());
        assertEquals(5_000L, info.getUptimeMs());
        assertEquals("node daemon.js", info.getCommand());
        assertEquals(87_654_321L, info.getHeapUsedBytes());
        assertEquals(3, info.getActiveRequestCount());
        assertEquals("sess-xyz", info.getSessionId());
        assertEquals("AI1", info.getTabName());
    }
}
