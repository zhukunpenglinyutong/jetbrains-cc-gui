package com.github.claudecodegui.service;

import com.google.gson.Gson;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import com.github.claudecodegui.diagnostics.DiagnosticConfig;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * F-007: Parses docs/bugs-jh/TRACKER.md and extracts open/testing bugs as JSON.
 * Used by DiagnosticHandler to provide the bug dropdown with live data.
 */
public final class TrackerParser {

    private static final Logger LOG = Logger.getInstance(TrackerParser.class);

    private static final Pattern BUG_PATTERN = Pattern.compile(
            "^\\| (B-\\d+) \\| [^|]+ \\| ([^|]+) \\| (open|testing) \\| ([^|]*) \\|"
    );

    private static final String TRACKER_RELATIVE = "docs/bugs-jh/TRACKER.md";

    private static final Gson GSON = new Gson();

    private TrackerParser() {
    }

    /**
     * Returns open bugs from TRACKER.md as a JSON array string.
     * Tries multiple strategies to locate the file.
     */
    public static String getOpenBugsAsJson(Project project) {
        Path trackerPath = findTrackerFile(project);
        if (trackerPath == null) {
            LOG.info("[TrackerParser] TRACKER.md not found");
            return "[]";
        }

        List<Map<String, String>> bugs = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(trackerPath)) {
            String line;
            while ((line = reader.readLine()) != null) {
                Matcher m = BUG_PATTERN.matcher(line);
                if (m.find()) {
                    Map<String, String> bug = new HashMap<>();
                    bug.put("id", m.group(1));
                    bug.put("label", extractLabel(m.group(2)));
                    bug.put("status", m.group(3).trim());
                    String changedOn = m.group(4).trim();
                    if (!changedOn.isEmpty() && !changedOn.equals("—")) {
                        bug.put("statusChangedOn", changedOn);
                    }
                    bugs.add(bug);
                }
            }
        } catch (IOException e) {
            LOG.error("[TrackerParser] Failed to parse TRACKER.md", e);
            return "[]";
        }

        LOG.info("[TrackerParser] Parsed " + bugs.size() + " open/testing bugs from " + trackerPath);
        return GSON.toJson(bugs);
    }

    /**
     * Locate TRACKER.md using multiple strategies:
     * 0. Configured path from ~/.codemoss/config.json (user setting)
     * 1. Project basePath (plugin source open in IDE)
     * 2. Plugin installation path (navigate up in dev mode)
     * 3. Gradle working directory (user.dir)
     */
    private static Path findTrackerFile(Project project) {
        // Strategy 0: Configured path from settings
        String configured = DiagnosticConfig.getTrackerPath();
        if (configured != null && !configured.isEmpty()) {
            Path p = Path.of(configured);
            if (Files.exists(p)) {
                return p;
            }
            LOG.info("[TrackerParser] Configured path not found: " + configured);
        }

        // Strategy 1: Project basePath
        if (project != null && project.getBasePath() != null) {
            Path p = Path.of(project.getBasePath(), TRACKER_RELATIVE);
            if (Files.exists(p)) {
                return p;
            }
        }

        // Strategy 2: Plugin installation path (dev mode — navigate up to project root)
        try {
            for (var descriptor : PluginManagerCore.getPlugins()) {
                if (descriptor.getPluginId().getIdString().contains("claudecodegui")
                        || descriptor.getPluginId().getIdString().contains("claude-code-gui")) {
                    Path pluginPath = descriptor.getPluginPath();
                    Path current = pluginPath;
                    for (int i = 0; i < 5 && current != null; i++) {
                        current = current.getParent();
                        if (current != null) {
                            Path tracker = current.resolve(TRACKER_RELATIVE);
                            if (Files.exists(tracker)) {
                                return tracker;
                            }
                        }
                    }
                    break;
                }
            }
        } catch (Exception e) {
            LOG.debug("[TrackerParser] Plugin path strategy failed: " + e.getMessage());
        }

        // Strategy 3: Gradle working directory
        String userDir = System.getProperty("user.dir");
        if (userDir != null) {
            Path p = Path.of(userDir, TRACKER_RELATIVE);
            if (Files.exists(p)) {
                return p;
            }
        }

        return null;
    }

    /**
     * Migrate tracker path from legacy cache file to config.json.
     * Called once on startup; deletes the old file after successful migration.
     */
    public static void migrateLegacyCachePath() {
        Path oldFile = Path.of(
                PlatformUtils.getHomeDirectory(), ".codemoss", "diagnostics", "tracker-path.txt");
        try {
            if (Files.exists(oldFile)) {
                String cached = Files.readString(oldFile, StandardCharsets.UTF_8).trim();
                if (!cached.isEmpty() && DiagnosticConfig.getTrackerPath().isEmpty()) {
                    DiagnosticConfig.setTrackerPath(cached);
                    LOG.info("[TrackerParser] Migrated tracker path from txt to config.json");
                }
                Files.deleteIfExists(oldFile);
                LOG.info("[TrackerParser] Deleted legacy tracker-path.txt");
            }
        } catch (Exception e) {
            LOG.debug("[TrackerParser] Migration failed: " + e.getMessage());
        }
    }

    /**
     * Extract a short label from the bug description.
     * Takes text up to the first sentence boundary or truncates at 80 chars.
     */
    private static String extractLabel(String description) {
        String trimmed = description.trim();
        // Remove leading markdown formatting (bold, backticks)
        trimmed = trimmed.replaceAll("^\\*\\*", "").replaceAll("\\*\\*$", "");

        int dotPos = trimmed.indexOf('.');
        if (dotPos > 0 && dotPos < 80) {
            return trimmed.substring(0, dotPos);
        }
        return trimmed.length() > 80 ? trimmed.substring(0, 77) + "..." : trimmed;
    }
}
