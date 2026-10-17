package com.github.claudecodegui.provider.codex;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies root/descendant writer ownership is isolated by Codex home scope. */
public class CodexThreadOwnerRegistryTest {

    @Test
    public void conflictingWindowsCannotClaimTheSameThread() {
        String scope = "test-scope-" + System.nanoTime();
        String firstOwner = "owner-a";
        String secondOwner = "owner-b";
        try {
            assertTrue(CodexThreadOwnerRegistry.claim(scope, "thread-root", firstOwner).acquired());
            assertFalse(CodexThreadOwnerRegistry.claim(scope, "thread-root", secondOwner).acquired());
            assertTrue(CodexThreadOwnerRegistry.claim(scope, "thread-child", firstOwner).acquired());
            assertTrue(firstOwner.equals(CodexThreadOwnerRegistry.ownerOf(scope, "thread-child")));
        } finally {
            CodexThreadOwnerRegistry.releaseOwner(firstOwner);
            CodexThreadOwnerRegistry.releaseOwner(secondOwner);
        }
    }

    @Test
    public void ownerLeaseReleaseReturnsRootAndChildTogether() {
        String scope = "test-scope-" + System.nanoTime();
        String owner = "owner-root";
        try {
            assertTrue(CodexThreadOwnerRegistry.claim(scope, "root", owner).acquired());
            assertTrue(CodexThreadOwnerRegistry.claim(scope, "child", owner).acquired());
            CodexThreadOwnerRegistry.releaseOwner(owner);
            assertTrue(CodexThreadOwnerRegistry.ownerOf(scope, "root") == null);
            assertTrue(CodexThreadOwnerRegistry.ownerOf(scope, "child") == null);
        } finally {
            CodexThreadOwnerRegistry.releaseOwner(owner);
        }
    }
}
