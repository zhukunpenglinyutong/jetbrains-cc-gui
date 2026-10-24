package com.github.claudecodegui.handler;

import org.junit.Test;

import java.util.Arrays;
import java.util.Set;

import static org.junit.Assert.assertTrue;

public class CodexStorageProtocolTest {
    @Test public void settingsDispatcherPublishesEveryStorageAction() throws Exception {
        var field = SettingsHandler.class.getDeclaredField("SUPPORTED_TYPES");
        field.setAccessible(true);
        Set<String> registered = Set.copyOf(Arrays.asList((String[]) field.get(null)));
        assertTrue("Storage actions must reach their handler through the real message registry",
                registered.containsAll(Arrays.asList(CodexStorageHandler.TYPES)));
    }
}
