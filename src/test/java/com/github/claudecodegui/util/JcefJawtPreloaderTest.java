package com.github.claudecodegui.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Tests the JAWT preflight without loading native libraries into the test JVM. */
public class JcefJawtPreloaderTest {
    /** Supplies boot-runtime layouts without inspecting the test runner's JDK. */
    @Rule
    public final TemporaryFolder runtime = new TemporaryFolder();

    /** A runtime property can select classic JCEF even with the Registry default enabled. */
    @Test
    public void explicitModeTakesPrecedenceOverRegistryDefault() {
        assertTrue(JcefJawtPreloader.requestsInProcess(true, "false"));
        assertFalse(JcefJawtPreloader.requestsInProcess(false, "true"));
    }

    /** Without an override, leave the normal out-of-process startup untouched. */
    @Test
    public void registryControlsModeWithoutOverride() {
        assertTrue(JcefJawtPreloader.requestsInProcess(false, null));
        assertFalse(JcefJawtPreloader.requestsInProcess(true, null));
    }

    /** Split JCEF can use the absolute path from the boot runtime. */
    @Test
    public void splitBundleCanPreloadBootRuntimeJawt() throws IOException {
        this.runtime.newFolder("lib");
        Path jawt = this.runtime.newFile("lib/libjawt.so").toPath();
        assertEquals(jawt, JcefJawtPreloader.findJawtForSplitBundle(this.runtime.getRoot().toPath()));
    }

    /** A bundled browser already has access to the library in its own ELF search path. */
    @Test
    public void bundledJcefDoesNotNeedPreloading() throws IOException {
        this.runtime.newFolder("lib");
        this.runtime.newFile("lib/libjawt.so");
        this.runtime.newFile("lib/libjcef.so");
        assertNull(JcefJawtPreloader.findJawtForSplitBundle(this.runtime.getRoot().toPath()));
    }

    /** Never fall back to an arbitrary library found on the system search path. */
    @Test
    public void absentBootRuntimeJawtIsNotPreloaded() throws IOException {
        this.runtime.newFolder("lib", "libjawt.so");
        assertNull(JcefJawtPreloader.findJawtForSplitBundle(this.runtime.getRoot().toPath()));
    }
}
