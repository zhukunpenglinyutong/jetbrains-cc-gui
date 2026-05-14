package com.github.claudecodegui.provider.common;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SharedBridgeReferenceCounterTest {

    @Test
    public void releaseReturnsTrueOnlyForLastOwner() {
        SharedBridgeReferenceCounter.retain(null);
        SharedBridgeReferenceCounter.retain(null);

        assertFalse(SharedBridgeReferenceCounter.release(null));
        assertTrue(SharedBridgeReferenceCounter.release(null));
    }
}
