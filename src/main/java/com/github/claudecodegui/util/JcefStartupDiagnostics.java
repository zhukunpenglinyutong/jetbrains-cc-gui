package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import org.cef.CefApp;

import java.lang.reflect.Field;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/** Exposes native startup failures that JCEF otherwise keeps in an unobserved future. */
public final class JcefStartupDiagnostics {
    private static final Logger LOG = Logger.getInstance(JcefStartupDiagnostics.class);

    private JcefStartupDiagnostics() {
    }

    /** Reads the current runtime state without creating or waiting for a CEF application. */
    public static String runtimeState() {
        try {
            return String.valueOf(CefApp.getState());
        } catch (RuntimeException | LinkageError failure) {
            return "unavailable (" + failure.getClass().getSimpleName() + ")";
        }
    }

    /** Returns an already-recorded native startup failure, if this JCEF exposes one. */
    public static Throwable nativeStartupFailure() {
        return nativeStartupFailure(CefApp.class);
    }

    /** Returns the Linux JAWT linker failure if native CEF startup has not advanced. */
    public static Throwable missingJawtStartupFailure() {
        return missingJawtStartupFailure(runtimeState(), CefApp.class);
    }

    static Throwable missingJawtStartupFailure(String state, Class<?> appClass) {
        // The asynchronous loader can fail before CefApp.getInstance() publishes a NEW instance.
        if (!"NONE".equals(state) && !"NEW".equals(state)) {
            return null;
        }
        Throwable failure = nativeStartupFailure(appClass);
        return isMissingJawt(failure) ? failure : null;
    }

    static boolean isMissingJawt(Throwable failure) {
        if (!(failure instanceof UnsatisfiedLinkError) || failure.getMessage() == null) {
            return false;
        }
        // Match the two ELF names, not glibc's localized explanation of the failure.
        return failure.getMessage().contains("libjcef.so: libjawt.so:");
    }

    static Throwable nativeStartupFailure(Class<?> appClass) {
        try {
            // This optional implementation detail is diagnostic only; never restart global CEF
            // or wait on its future from an EDT callback. Older JCEF builds may omit the field.
            Field field = appClass.getDeclaredField("ourStartupFeature");
            field.setAccessible(true);
            Object value = field.get(null);
            if (value instanceof CompletableFuture<?> future && future.isDone()) {
                try {
                    future.join();
                } catch (CompletionException failure) {
                    return failure.getCause() == null ? failure : failure.getCause();
                } catch (CancellationException failure) {
                    return failure;
                }
            }
        } catch (ReflectiveOperationException | RuntimeException | LinkageError failure) {
            LOG.debug("Native JCEF startup future is unavailable for diagnostics", failure);
        }
        return null;
    }
}
