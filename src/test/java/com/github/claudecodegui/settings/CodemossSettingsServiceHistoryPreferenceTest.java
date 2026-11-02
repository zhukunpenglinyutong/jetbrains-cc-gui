package com.github.claudecodegui.settings;

import com.intellij.ide.util.AppPropertyService;
import com.intellij.ide.util.PropertiesComponent;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Exercises the startup-history preference against IntelliJ's real property store. */
public class CodemossSettingsServiceHistoryPreferenceTest {

    @Test
    public void startupLoadingDefaultsToEnabled() {
        assertTrue(CodemossSettingsService.readLoadHistoryOnStartup(new AppPropertyService()));
    }

    @Test
    public void disabledStartupLoadingIsPersistedInsteadOfFallingBackToTheDefault() {
        PropertiesComponent properties = new AppPropertyService();

        CodemossSettingsService.storeLoadHistoryOnStartup(properties, false);

        assertEquals("false", properties.getValue(CodemossSettingsService.LOAD_HISTORY_ON_STARTUP_PROPERTY_KEY));
        assertFalse(CodemossSettingsService.readLoadHistoryOnStartup(properties));
    }

    @Test
    public void reenablingStartupLoadingRestoresTheDefault() {
        PropertiesComponent properties = new AppPropertyService();
        CodemossSettingsService.storeLoadHistoryOnStartup(properties, false);

        CodemossSettingsService.storeLoadHistoryOnStartup(properties, true);

        assertTrue(CodemossSettingsService.readLoadHistoryOnStartup(properties));
    }
}
