package com.github.claudecodegui.startup;

import com.github.claudecodegui.util.JcefJawtPreloader;
import com.intellij.ide.AppLifecycleListener;

import java.util.List;

/** Prepares the split JCEF runtime before restored projects can open browser tool windows. */
public final class JcefNativeStartupListener implements AppLifecycleListener {
    /** Preloads JAWT without initializing JCEF or modifying its settings. */
    @Override
    public void appFrameCreated(List<String> commandLineArgs) {
        JcefJawtPreloader.preloadIfNeeded();
    }
}
