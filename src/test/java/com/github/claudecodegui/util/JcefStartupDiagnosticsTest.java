package com.github.claudecodegui.util;

import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/** Tests optional native startup diagnostics without starting the global CEF application. */
public class JcefStartupDiagnosticsTest {
    private static final class AppWithStartupFuture {
        private static CompletableFuture<Void> ourStartupFeature;
    }

    private static final class OlderApp {
    }

    /** A pending native startup must never block the EDT while diagnostics are collected. */
    @Test(timeout = 1000)
    public void pendingStartupIsReadWithoutWaiting() {
        AppWithStartupFuture.ourStartupFeature = new CompletableFuture<>();
        assertNull(JcefStartupDiagnostics.nativeStartupFailure(AppWithStartupFuture.class));
    }

    /** Successful native startup must not be mistaken for a page or bridge failure. */
    @Test
    public void successfulStartupHasNoNativeFailure() {
        AppWithStartupFuture.ourStartupFeature = CompletableFuture.completedFuture(null);
        assertNull(JcefStartupDiagnostics.nativeStartupFailure(AppWithStartupFuture.class));
    }

    /** Native library failures retain their original cause rather than only a future wrapper. */
    @Test
    public void failedStartupExposesOriginalNativeCause() {
        UnsatisfiedLinkError failure = new UnsatisfiedLinkError("test native load failure");
        AppWithStartupFuture.ourStartupFeature = CompletableFuture.failedFuture(failure);
        assertSame(failure, JcefStartupDiagnostics.nativeStartupFailure(AppWithStartupFuture.class));
    }

    /** Cancelled native startup is reported without throwing into the watchdog callback. */
    @Test
    public void cancelledStartupCanBeReported() {
        AppWithStartupFuture.ourStartupFeature = new CompletableFuture<>();
        AppWithStartupFuture.ourStartupFeature.cancel(false);
        assertNotNull(JcefStartupDiagnostics.nativeStartupFailure(AppWithStartupFuture.class));
    }

    /** The restart path must recognize the linker error independently of the OS locale. */
    @Test
    public void detectsJawtFailureWithLocalizedLinkerMessage() {
        assertTrue(JcefStartupDiagnostics.isMissingJawt(new UnsatisfiedLinkError(
                "/jcef/libjcef.so: libjawt.so: 无法打开共享对象文件: 没有那个文件或目录")));
    }

    /** The native loader can fail before CEF has created its Java application instance. */
    @Test
    public void recognizesJawtFailureBeforeCefAppExists() {
        UnsatisfiedLinkError failure = new UnsatisfiedLinkError("/jcef/libjcef.so: libjawt.so: not found");
        AppWithStartupFuture.ourStartupFeature = CompletableFuture.failedFuture(failure);
        assertSame(failure, JcefStartupDiagnostics.missingJawtStartupFailure("NONE", AppWithStartupFuture.class));
        assertSame(failure, JcefStartupDiagnostics.missingJawtStartupFailure("NEW", AppWithStartupFuture.class));
        assertNull(JcefStartupDiagnostics.missingJawtStartupFailure("INITIALIZED", AppWithStartupFuture.class));
    }

    /** Do not special-case unrelated failures or errors that merely mention JAWT. */
    @Test
    public void unrelatedStartupFailuresDoNotRequireTheJawtWorkaround() {
        assertFalse(JcefStartupDiagnostics.isMissingJawt(null));
        assertFalse(JcefStartupDiagnostics.isMissingJawt(new UnsatisfiedLinkError()));
        assertFalse(JcefStartupDiagnostics.isMissingJawt(new UnsatisfiedLinkError("/jcef/libjcef.so: libnss3.so: not found")));
        assertFalse(JcefStartupDiagnostics.isMissingJawt(new IllegalStateException("/jcef/libjcef.so: libjawt.so: not found")));
    }

    /** Older JCEF builds remain usable when the optional internal future is absent. */
    @Test
    public void missingFutureIsOnlyADiagnosticLimitation() {
        assertNull(JcefStartupDiagnostics.nativeStartupFailure(OlderApp.class));
        AppWithStartupFuture.ourStartupFeature = null;
        assertNull(JcefStartupDiagnostics.nativeStartupFailure(AppWithStartupFuture.class));
    }
}
