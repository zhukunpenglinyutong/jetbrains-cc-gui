package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.After;
import org.junit.Test;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.Assert.*;

public class CodemossSettingsServiceSessionRepositoryMatchingTest {
    private String previousHome;
    private Field homeField;
    @After public void restoreHome() throws Exception {
        if (homeField != null) { homeField.set(null, previousHome); }
    }
    @Test public void defaultsOffAndPersistsAcrossSettingsInstances() throws Exception {
        Path temporaryHome = Files.createTempDirectory("session-repository-preference");
        homeField = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");homeField.setAccessible(true);
        previousHome = (String) homeField.get(null);homeField.set(null, temporaryHome.toString());
        CodemossSettingsService settings = new CodemossSettingsService();
        assertFalse(settings.getSessionGitRepositoryMatchingEnabled());
        settings.setSessionGitRepositoryMatchingEnabled(true);
        assertTrue(new CodemossSettingsService().getSessionGitRepositoryMatchingEnabled());
        settings.setSessionGitRepositoryMatchingEnabled(false);
        assertFalse(new CodemossSettingsService().getSessionGitRepositoryMatchingEnabled());
    }
}
