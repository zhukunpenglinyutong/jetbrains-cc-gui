package com.github.claudecodegui.service;

import org.junit.Test;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link NodeProcessRegistry} package-private helpers.
 *
 * <p>The full service requires a running {@link com.intellij.openapi.project.Project},
 * so we cover the orphan-classification heuristics directly — they are the
 * security-sensitive part of the orphan scanner and must never produce false
 * positives that would let users kill unrelated Node processes.
 */
public class NodeProcessRegistryHelpersTest {

    // -- looksLikeOurProcess ----------------------------------------------------

    @Test
    public void looksLikeOurProcessMatchesDaemonJs() {
        assertTrue(NodeProcessRegistry.looksLikeOurProcess("node /Users/me/.codemoss/ai-bridge/daemon.js"));
    }

    @Test
    public void looksLikeOurProcessMatchesChannelManager() {
        assertTrue(NodeProcessRegistry.looksLikeOurProcess(
                "/usr/local/bin/node /Users/me/.codemoss/ai-bridge/channel-manager.js codex send"));
    }

    @Test
    public void looksLikeOurProcessIsCaseInsensitive() {
        assertTrue(NodeProcessRegistry.looksLikeOurProcess("NODE DAEMON.JS"));
    }

    @Test
    public void looksLikeOurProcessRejectsUnrelatedNode() {
        // Defense against false positives — must not kill arbitrary user Node processes
        assertFalse(NodeProcessRegistry.looksLikeOurProcess("node /Users/me/projects/myapp/server.js"));
    }

    @Test
    public void looksLikeOurProcessRejectsPlainNodeRepl() {
        assertFalse(NodeProcessRegistry.looksLikeOurProcess("node"));
    }

    @Test
    public void looksLikeOurProcessRejectsEmptyAndNull() {
        assertFalse(NodeProcessRegistry.looksLikeOurProcess(null));
        assertFalse(NodeProcessRegistry.looksLikeOurProcess(""));
        assertFalse(NodeProcessRegistry.looksLikeOurProcess("   "));
    }

    // -- detectProviderFromCmd --------------------------------------------------

    @Test
    public void detectProviderClassifiesDaemonAsClaude() {
        assertEquals("claude", NodeProcessRegistry.detectProviderFromCmd("node /path/daemon.js"));
    }

    @Test
    public void detectProviderClassifiesCodexCommand() {
        assertEquals("codex",
                NodeProcessRegistry.detectProviderFromCmd("node /path/channel-manager.js codex send"));
    }

    @Test
    public void detectProviderClassifiesClaudeCommand() {
        // claude appears in the path but daemon.js doesn't — still claude
        assertEquals("claude",
                NodeProcessRegistry.detectProviderFromCmd("node /path/claude-channel.js send"));
    }

    @Test
    public void detectProviderReturnsNullForUnknownCmd() {
        assertNull(NodeProcessRegistry.detectProviderFromCmd("node /path/random.js"));
    }

    @Test
    public void detectProviderHandlesNull() {
        assertNull(NodeProcessRegistry.detectProviderFromCmd(null));
    }

    // ============================================================================
    // Ownership check — prevents IDEA from claiming PyCharm's daemons as orphans
    // (and vice-versa) when both run CC GUI side-by-side.
    // ============================================================================

    @Test
    public void isOwnedByJvmMatchesOwnChildren() {
        // The happy path: a process whose parent IS this JVM is a candidate orphan.
        assertTrue(NodeProcessRegistry.isOwnedByJvm(12345L, 12345L));
    }

    @Test
    public void isOwnedByJvmRejectsForeignJvmChildren() {
        // The bug fix: IDEA must NOT claim a daemon whose parent is PyCharm's JVM,
        // otherwise "Kill all orphans" would terminate live work in PyCharm.
        assertFalse(NodeProcessRegistry.isOwnedByJvm(99999L, 12345L));
        assertFalse(NodeProcessRegistry.isOwnedByJvm(54321L, 12345L));
    }

    @Test
    public void isOwnedByJvmRejectsMissingParent() {
        // ProcessHandle.parent() returns Optional.empty() (mapped to -1L by the caller)
        // when the parent has died and the process was re-parented to init/launchd.
        // Such truly-detached orphans cannot be safely attributed to any specific
        // JVM, so we leave them alone.
        assertFalse(NodeProcessRegistry.isOwnedByJvm(-1L, 12345L));
        assertFalse(NodeProcessRegistry.isOwnedByJvm(0L, 12345L));
    }

    @Test
    public void isOwnedByJvmHandlesPidOne() {
        // PID 1 (init/launchd) means parent died and the OS re-parented. Not ours.
        assertFalse(NodeProcessRegistry.isOwnedByJvm(1L, 12345L));
    }

    // ============================================================================
    // Kill ownership guard — killByPid must refuse PIDs that are not in our own
    // snapshot, so a malformed/hostile frontend payload cannot terminate an
    // arbitrary process tree on the host.
    // ============================================================================

    @Test
    public void isPidOwnedAcceptsTrackedPid() {
        Set<Long> owned = new HashSet<>();
        owned.add(12345L);
        owned.add(67890L);
        assertTrue(NodeProcessRegistry.isPidOwned(12345L, owned));
        assertTrue(NodeProcessRegistry.isPidOwned(67890L, owned));
    }

    @Test
    public void isPidOwnedRejectsUntrackedPid() {
        // The security fix: a PID the frontend invented (or another process tree)
        // must never be eligible for termination.
        Set<Long> owned = new HashSet<>();
        owned.add(12345L);
        assertFalse(NodeProcessRegistry.isPidOwned(99999L, owned));
    }

    @Test
    public void isPidOwnedRejectsEmptyAndNullSet() {
        assertFalse(NodeProcessRegistry.isPidOwned(12345L, Collections.emptySet()));
        assertFalse(NodeProcessRegistry.isPidOwned(12345L, null));
    }

    @Test
    public void isPidOwnedRejectsNonPositivePid() {
        Set<Long> owned = new HashSet<>();
        owned.add(0L);
        owned.add(-1L);
        // Even if a bogus non-positive value somehow lands in the set, it is never killable.
        assertFalse(NodeProcessRegistry.isPidOwned(0L, owned));
        assertFalse(NodeProcessRegistry.isPidOwned(-1L, owned));
    }
}
