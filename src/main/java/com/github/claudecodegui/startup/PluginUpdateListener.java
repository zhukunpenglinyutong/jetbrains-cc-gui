package com.github.claudecodegui.startup;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Plugin update listener that tracks plugin version changes.
 * Bridge extraction is already version/hash-aware, so deleting the live ai-bridge
 * directory here is both unnecessary and risky on Windows while the daemon is active.
 */
public class PluginUpdateListener implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(PluginUpdateListener.class);
    private static final String LAST_VERSION_KEY = "claude.code.last.plugin.version";

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                checkAndCleanupOldCache();
            } catch (Exception e) {
                LOG.warn("[PluginUpdateListener] Failed to check plugin version: " + e.getMessage(), e);
            }
        });
        return Unit.INSTANCE;
    }

    /**
     * Check if plugin version has changed and cleanup old cache if needed.
     */
    private void checkAndCleanupOldCache() {
        try {
            PluginId pluginId = PluginId.getId(PlatformUtils.getPluginId());
            IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(pluginId);
            if (descriptor == null) {
                LOG.debug("[PluginUpdateListener] Plugin descriptor not found");
                return;
            }

            String currentVersion = descriptor.getVersion();
            PropertiesComponent props = PropertiesComponent.getInstance();
            String lastVersion = props.getValue(LAST_VERSION_KEY);

            LOG.info("[PluginUpdateListener] Current version: " + currentVersion + ", Last version: " + lastVersion);

            if (lastVersion != null && !lastVersion.equals(currentVersion)) {
                LOG.info("[PluginUpdateListener] Plugin version changed from " + lastVersion + " to " + currentVersion
                        + ". Skipping ai-bridge deletion; BridgeDirectoryResolver will refresh by signature.");
            }

            // Update stored version
            props.setValue(LAST_VERSION_KEY, currentVersion);
        } catch (Exception e) {
            LOG.warn("[PluginUpdateListener] Failed to check plugin version: " + e.getMessage(), e);
        }
    }
}
