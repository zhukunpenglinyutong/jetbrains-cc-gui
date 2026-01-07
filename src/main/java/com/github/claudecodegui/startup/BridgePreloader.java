package com.github.claudecodegui.startup;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.concurrent.CompletableFuture;

/**
 * Pre-loads the AI Bridge on project startup to avoid EDT freeze
 * when opening the tool window for the first time.
 *
 * This activity runs in the background after the project is opened,
 * triggering the ai-bridge.zip extraction early so it's ready
 * when the user opens the Claude tool window.
 */
public class BridgePreloader implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(BridgePreloader.class);

    // Shared resolver instance for preloading
    private static volatile BridgeDirectoryResolver sharedResolver;
    private static final Object RESOLVER_LOCK = new Object();

    /**
     * Get or create the shared resolver instance.
     * This ensures extraction only happens once across all components.
     */
    public static BridgeDirectoryResolver getSharedResolver() {
        if (sharedResolver == null) {
            synchronized (RESOLVER_LOCK) {
                if (sharedResolver == null) {
                    sharedResolver = new BridgeDirectoryResolver();
                }
            }
        }
        return sharedResolver;
    }

    /**
     * Check if bridge extraction is complete (non-blocking).
     * Returns true if bridge is ready, false if still extracting or not started.
     */
    public static boolean isBridgeReady() {
        BridgeDirectoryResolver resolver = getSharedResolver();
        return resolver.isExtractionComplete();
    }

    /**
     * Get a future that completes when extraction is done.
     * This allows callers to wait asynchronously without blocking EDT.
     */
    public static CompletableFuture<Boolean> waitForBridgeAsync() {
        BridgeDirectoryResolver resolver = getSharedResolver();
        return resolver.getExtractionFuture();
    }

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        LOG.info("[BridgePreloader] Starting bridge preload for project: " + project.getName());

        // Run extraction on a background thread
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                BridgeDirectoryResolver resolver = getSharedResolver();

                // Trigger extraction (non-blocking on this pooled thread)
                resolver.findSdkDir();

                LOG.info("[BridgePreloader] Bridge preload completed for project: " + project.getName());
            } catch (Exception e) {
                LOG.warn("[BridgePreloader] Bridge preload failed: " + e.getMessage(), e);
            }
        });

        return Unit.INSTANCE;
    }
}
