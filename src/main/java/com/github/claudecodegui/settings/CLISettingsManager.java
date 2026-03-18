package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.CLIDetector;
import com.github.claudecodegui.model.CliDetectionResult;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Claude Code CLI Settings Manager.
 * Manages CLI detection state and configuration.
 */
public class CLISettingsManager {

    private static final Logger LOG = Logger.getInstance(CLISettingsManager.class);

    private final CLIDetector cliDetector;

    // Configuration state
    private String cliExecutablePath;
    private boolean cliDetected;
    private String cliVersion;
    private boolean fallbackToAPI = true;

    public CLISettingsManager(CLIDetector cliDetector) {
        this.cliDetector = cliDetector;
        this.cliExecutablePath = null;
        this.cliDetected = false;
        this.cliVersion = null;
    }

    /**
     * Initialize CLI detection.
     * Attempts to auto-detect the CLI executable.
     */
    public void initializeDetection() {
        try {
            CliDetectionResult result = cliDetector.detectCliWithDetails();
            if (result != null && result.isFound()) {
                this.cliExecutablePath = result.getCliPath();
                this.cliDetected = true;
                this.cliVersion = result.getCliVersion();
                LOG.info("[CLISettingsManager] CLI detected: " + cliExecutablePath + " (" + cliVersion + ")");
            } else {
                this.cliDetected = false;
                this.cliExecutablePath = null;
                this.cliVersion = null;
                LOG.info("[CLISettingsManager] CLI not detected, will fallback to API mode");
            }
        } catch (Exception e) {
            LOG.warn("[CLISettingsManager] CLI detection failed: " + e.getMessage());
            this.cliDetected = false;
        }
    }

    /**
     * Refresh CLI detection.
     * Re-runs detection and updates state.
     */
    public void refreshDetection() {
        cliDetector.clearCache();
        initializeDetection();
    }

    /**
     * Get the CLI executable path.
     * @return CLI path, or null if not detected
     */
    public String getCliExecutablePath() {
        if (cliExecutablePath == null) {
            initializeDetection();
        }
        return cliExecutablePath;
    }

    /**
     * Check if CLI is detected and available.
     * @return true if CLI is available
     */
    public boolean isCliDetected() {
        if (!cliDetected && cliExecutablePath == null) {
            initializeDetection();
        }
        return cliDetected;
    }

    /**
     * Get the CLI version.
     * @return CLI version string, or null if not detected
     */
    public String getCliVersion() {
        if (cliVersion == null) {
            initializeDetection();
        }
        return cliVersion;
    }

    /**
     * Check if fallback to API is enabled.
     * @return true if fallback is enabled
     */
    public boolean isFallbackToAPI() {
        return fallbackToAPI;
    }

    /**
     * Set whether to fallback to API when CLI is unavailable.
     * @param fallback true to enable fallback
     */
    public void setFallbackToAPI(boolean fallback) {
        this.fallbackToAPI = fallback;
    }

    /**
     * Set a custom CLI executable path.
     * @param path the CLI executable path
     */
    public void setCliExecutablePath(String path) {
        this.cliExecutablePath = path;
        cliDetector.setCliExecutable(path);
        if (path != null && !path.isEmpty()) {
            CliDetectionResult result = cliDetector.verifyAndCacheCliPath(path);
            this.cliDetected = result.isFound();
            this.cliVersion = result.getCliVersion();
        } else {
            this.cliDetected = false;
            this.cliVersion = null;
        }
    }

    /**
     * Get the cached detection result.
     * @return the cached detection result
     */
    public CliDetectionResult getCachedDetectionResult() {
        return cliDetector.getCachedDetectionResult();
    }

    /**
     * Clear cached CLI detection state.
     */
    public void clearCache() {
        cliDetector.clearCache();
        this.cliExecutablePath = null;
        this.cliDetected = false;
        this.cliVersion = null;
    }
}
