package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.openapi.util.registry.Registry;

import java.nio.file.Files;
import java.nio.file.Path;

/** Makes the boot runtime's JAWT library visible to a split Linux JCEF bundle. */
public final class JcefJawtPreloader {
    private static final Logger LOG = Logger.getInstance(JcefJawtPreloader.class);
    private static final String JCEF_ENABLED_KEY = "ide.browser.jcef.enabled";
    private static final String OUT_OF_PROCESS_KEY = "ide.browser.jcef.out-of-process.enabled";
    private static boolean loadAttempted;

    private JcefJawtPreloader() {
    }

    /** Preloads JAWT before the native launcher starts an explicitly in-process JCEF. */
    public static synchronized void preloadIfNeeded() {
        if (loadAttempted || !SystemInfo.isLinux || !Boolean.getBoolean("ide.native.launcher")) {
            return;
        }
        try {
            if (!Registry.is(JCEF_ENABLED_KEY, true)
                    || !requestsInProcess(Registry.is(OUT_OF_PROCESS_KEY, true), System.getProperty("jcef.remote.enabled"))) {
                return;
            }
            Path jawt = findJawtForSplitBundle(Path.of(System.getProperty("java.home")));
            if (jawt == null) {
                return;
            }
            loadAttempted = true;
            // The Linux native launcher lacks bin/java's RPATH. libjcef.so only searches its
            // own directory, so load JAWT by absolute path before CEF resolves its ELF dependencies.
            System.load(jawt.toString());
            LOG.info("[WebviewStartup] Preloaded boot runtime JAWT for in-process JCEF: " + jawt);
        } catch (RuntimeException | LinkageError failure) {
            // A runtime with its own loader fix can still start. Leave CEF startup to the IDE.
            LOG.warn("[WebviewStartup] Could not preload JAWT for in-process JCEF", failure);
        }
    }

    static boolean requestsInProcess(boolean outOfProcess, String remoteOverride) {
        // JCefAppConfig reads the explicit property when the platform or user already set it.
        return remoteOverride == null ? !outOfProcess : !Boolean.parseBoolean(remoteOverride);
    }

    static Path findJawtForSplitBundle(Path javaHome) {
        Path lib = javaHome.toAbsolutePath().resolve("lib");
        Path jawt = lib.resolve("libjawt.so");
        // Bundled JCEF can already find JAWT next to libjcef.so.
        return Files.isRegularFile(jawt) && !Files.isRegularFile(lib.resolve("libjcef.so")) ? jawt : null;
    }
}
