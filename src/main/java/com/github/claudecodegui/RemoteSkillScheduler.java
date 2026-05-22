package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Remote skill auto-update scheduler.
 * Periodically checks for skills that need updating based on their update interval and nextUpdate time.
 */
public class RemoteSkillScheduler implements ProjectActivity {
    private static final Logger LOG = Logger.getInstance(RemoteSkillScheduler.class);
    private static final Gson GSON = new Gson();
    private static final long CHECK_INTERVAL_MINUTES = 5; // Check every 5 minutes

    private static ScheduledExecutorService scheduler;
    private static volatile boolean isInitialized = false;

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        // Only initialize once across all projects
        if (!isInitialized) {
            synchronized (RemoteSkillScheduler.class) {
                if (!isInitialized) {
                    startScheduler(project);
                    isInitialized = true;
                    LOG.info("[RemoteSkillScheduler] Auto-update scheduler initialized");
                }
            }
        }
        return null;
    }

    /**
     * Start the scheduler that periodically checks for updates.
     */
    private static void startScheduler(Project project) {
        if (scheduler != null && !scheduler.isShutdown()) {
            LOG.warn("[RemoteSkillScheduler] Scheduler already running");
            return;
        }

        scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "RemoteSkillScheduler");
            thread.setDaemon(true); // Allow JVM to exit even if thread is running
            return thread;
        });

        // Initial delay of 1 minute, then check every CHECK_INTERVAL_MINUTES
        scheduler.scheduleAtFixedRate(
            () -> checkAndUpdateSkills(project),
            1, // Initial delay: 1 minute
            CHECK_INTERVAL_MINUTES,
            TimeUnit.MINUTES
        );

        LOG.info("[RemoteSkillScheduler] Scheduler started, checking every " + CHECK_INTERVAL_MINUTES + " minutes");
    }

    /**
     * Check all remote skills and update those that are due for update.
     */
    private static void checkAndUpdateSkills(Project project) {
        try {
            LOG.debug("[RemoteSkillScheduler] Starting periodic check for skill updates");

            Map<String, RemoteSkillService.RemoteSkillConfig> configs = loadRemoteConfig();
            if (configs.isEmpty()) {
                LOG.debug("[RemoteSkillScheduler] No remote skills configured");
                return;
            }

            long currentTime = System.currentTimeMillis();
            int updatedCount = 0;
            int failedCount = 0;

            for (Map.Entry<String, RemoteSkillService.RemoteSkillConfig> entry : configs.entrySet()) {
                RemoteSkillService.RemoteSkillConfig config = entry.getValue();

                // Skip manual update skills
                if ("manual".equals(config.updateInterval)) {
                    continue;
                }

                // Skip if nextUpdate time hasn't been reached yet
                if (config.nextUpdate <= 0 || currentTime < config.nextUpdate) {
                    continue;
                }

                // Time to update this skill
                LOG.info("[RemoteSkillScheduler] Auto-updating skill: " + config.name +
                        " (scope: " + config.scope + ", interval: " + config.updateInterval + ")");

                try {
                    String workspaceRoot = project.getBasePath();
                    JsonObject result = RemoteSkillService.updateRemoteSkill(
                        config.name,
                        config.scope,
                        config.url,
                        workspaceRoot
                    );

                    if (result.has("success") && result.get("success").getAsBoolean()) {
                        updatedCount++;
                        LOG.info("[RemoteSkillScheduler] Successfully auto-updated skill: " + config.name);
                    } else {
                        failedCount++;
                        String error = result.has("error") ? result.get("error").getAsString() : "Unknown error";
                        LOG.warn("[RemoteSkillScheduler] Failed to auto-update skill: " + config.name + " - " + error);
                    }
                } catch (Exception e) {
                    failedCount++;
                    LOG.error("[RemoteSkillScheduler] Exception while auto-updating skill: " + config.name, e);
                }
            }

            if (updatedCount > 0 || failedCount > 0) {
                LOG.info("[RemoteSkillScheduler] Update check completed: " +
                        updatedCount + " updated, " + failedCount + " failed");
            }
        } catch (Exception e) {
            LOG.error("[RemoteSkillScheduler] Error during periodic check", e);
        }
    }

    /**
     * Load remote skills configuration.
     * Duplicated from RemoteSkillService to avoid coupling.
     */
    private static Map<String, RemoteSkillService.RemoteSkillConfig> loadRemoteConfig() {
        Map<String, RemoteSkillService.RemoteSkillConfig> configs = new java.util.HashMap<>();
        try {
            String configPath = getRemoteConfigPath();
            File configFile = new File(configPath);
            if (!configFile.exists()) {
                return configs;
            }

            String content = new String(Files.readAllBytes(configFile.toPath()));
            JsonObject json = GSON.fromJson(content, JsonObject.class);

            for (String key : json.keySet()) {
                RemoteSkillService.RemoteSkillConfig config = GSON.fromJson(
                    json.get(key),
                    RemoteSkillService.RemoteSkillConfig.class
                );
                configs.put(key, config);
            }
        } catch (Exception e) {
            LOG.error("[RemoteSkillScheduler] Failed to load remote config: " + e.getMessage(), e);
        }
        return configs;
    }

    /**
     * Get the remote skills configuration file path.
     */
    private static String getRemoteConfigPath() {
        String homeDir = com.github.claudecodegui.util.PlatformUtils.getHomeDirectory();
        return java.nio.file.Paths.get(homeDir, ".codemoss", "skills", "remote-skills.json").toString();
    }

    /**
     * Stop the scheduler (for testing or cleanup).
     */
    public static void stopScheduler() {
        if (scheduler != null && !scheduler.isShutdown()) {
            scheduler.shutdown();
            try {
                if (!scheduler.awaitTermination(5, TimeUnit.SECONDS)) {
                    scheduler.shutdownNow();
                }
                LOG.info("[RemoteSkillScheduler] Scheduler stopped");
            } catch (InterruptedException e) {
                scheduler.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
        isInitialized = false;
    }

    /**
     * Trigger an immediate check (for testing or manual refresh).
     */
    public static void triggerImmediateCheck(Project project) {
        if (project == null) {
            LOG.warn("[RemoteSkillScheduler] Cannot trigger check: project is null");
            return;
        }
        LOG.info("[RemoteSkillScheduler] Triggering immediate update check");
        checkAndUpdateSkills(project);
    }
}
