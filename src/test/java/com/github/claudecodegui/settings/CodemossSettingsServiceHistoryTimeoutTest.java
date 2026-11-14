package com.github.claudecodegui.settings;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class CodemossSettingsServiceHistoryTimeoutTest {

    @Test
    public void clampsHistoryLoadTimeoutToSupportedRange() {
        assertEquals(5, CodemossSettingsService.clampHistoryLoadTimeoutSeconds(-1));
        assertEquals(10, CodemossSettingsService.clampHistoryLoadTimeoutSeconds(10));
        assertEquals(120, CodemossSettingsService.clampHistoryLoadTimeoutSeconds(999));
    }
}
