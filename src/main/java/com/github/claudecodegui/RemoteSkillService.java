package com.github.claudecodegui;

import com.github.claudecodegui.skill.SkillService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Remote skill management service.
 * Handles downloading, updating, and scheduling remote skills.
 */
public class RemoteSkillService {
    private static final Logger LOG = Logger.getInstance(RemoteSkillService.class);
    private static final Gson GSON = new Gson();
    private static final String REMOTE_SKILLS_CONFIG = "remote-skills.json";
    private static final int CONNECT_TIMEOUT = 10000; // 10 seconds
    private static final int READ_TIMEOUT = 30000; // 30 seconds

    /**
     * Remote skill configuration entry.
     */
    public static class RemoteSkillConfig {
        public String name;
        public String scope;
        public String url;
        public String updateInterval;
        public long lastUpdated;
        public long nextUpdate;
    }

    /**
     * Navigation directory entry parsed from Markdown table.
     */
    public static class NavigationEntry {
        public String name;
        public String description;
        public String url;
        public String tags;
        public String lastUpdate;
    }

    /**
     * Batch import result.
     */
    public static class BatchImportResult {
        public int total;
        public int succeeded;
        public int failed;
        public List<String> successList = new ArrayList<>();
        public List<String> failureList = new ArrayList<>();
        public List<String> errorMessages = new ArrayList<>();
    }

    /**
     * Get the remote skills configuration directory.
     */
    private static String getRemoteConfigDir() {
        String homeDir = PlatformUtils.getHomeDirectory();
        return Paths.get(homeDir, ".codemoss", "skills").toString();
    }

    /**
     * Get the remote skills configuration file path.
     */
    private static String getRemoteConfigPath() {
        return Paths.get(getRemoteConfigDir(), REMOTE_SKILLS_CONFIG).toString();
    }

    /**
     * Load remote skills configuration.
     */
    private static Map<String, RemoteSkillConfig> loadRemoteConfig() {
        Map<String, RemoteSkillConfig> configs = new HashMap<>();
        try {
            File configFile = new File(getRemoteConfigPath());
            if (!configFile.exists()) {
                return configs;
            }

            String content = new String(Files.readAllBytes(configFile.toPath()));
            JsonObject json = GSON.fromJson(content, JsonObject.class);

            for (String key : json.keySet()) {
                RemoteSkillConfig config = GSON.fromJson(json.get(key), RemoteSkillConfig.class);
                configs.put(key, config);
            }
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to load remote config: " + e.getMessage(), e);
        }
        return configs;
    }

    /**
     * Save remote skills configuration.
     */
    private static void saveRemoteConfig(Map<String, RemoteSkillConfig> configs) {
        try {
            File configDir = new File(getRemoteConfigDir());
            if (!configDir.exists()) {
                configDir.mkdirs();
            }

            JsonObject json = new JsonObject();
            for (Map.Entry<String, RemoteSkillConfig> entry : configs.entrySet()) {
                json.add(entry.getKey(), GSON.toJsonTree(entry.getValue()));
            }

            File configFile = new File(getRemoteConfigPath());
            Files.write(configFile.toPath(), GSON.toJson(json).getBytes());
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to save remote config: " + e.getMessage(), e);
        }
    }

    /**
     * Download file from URL.
     */
    private static byte[] downloadFile(String urlString) throws IOException {
        URL url = new URL(urlString);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT);
        conn.setReadTimeout(READ_TIMEOUT);
        conn.setRequestProperty("User-Agent", "IDEA-Claude-Code-GUI");

        try {
            int responseCode = conn.getResponseCode();
            if (responseCode != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP error: " + responseCode);
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            try (InputStream is = conn.getInputStream()) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = is.read(buffer)) != -1) {
                    baos.write(buffer, 0, bytesRead);
                }
            }
            return baos.toByteArray();
        } finally {
            conn.disconnect();
        }
    }

    /**
     * Extract skill name from URL.
     */
    private static String extractSkillName(String url) {
        String name = url.substring(url.lastIndexOf('/') + 1);
        // Remove extension
        if (name.endsWith(".md")) {
            name = name.substring(0, name.length() - 3);
        } else if (name.endsWith(".zip")) {
            name = name.substring(0, name.length() - 4);
        }
        // Sanitize name
        name = name.replaceAll("[^a-zA-Z0-9._-]", "-").toLowerCase();
        return name;
    }

    /**
     * Import remote skill.
     */
    public static JsonObject importRemoteSkill(String url, String scope, String updateInterval, String workspaceRoot) {
        JsonObject result = new JsonObject();

        try {
            // Download file
            LOG.info("[RemoteSkillService] Downloading skill from: " + url);
            byte[] data = downloadFile(url);

            String skillName = extractSkillName(url);
            LOG.info("[RemoteSkillService] Extracted skill name: " + skillName);

            // Determine target directory
            String targetDir;
            if ("global".equals(scope) || "user".equals(scope)) {
                targetDir = SkillService.getGlobalSkillsDir();
                LOG.info("[RemoteSkillService] Using global skills directory: " + targetDir);
            } else {
                LOG.info("[RemoteSkillService] Using local scope with workspaceRoot: " + workspaceRoot);
                targetDir = SkillService.getLocalSkillsDir(workspaceRoot);
                LOG.info("[RemoteSkillService] Local skills directory: " + targetDir);
            }

            if (targetDir == null) {
                String errorMsg = "Cannot determine target directory for scope=" + scope + ", workspaceRoot=" + workspaceRoot;
                LOG.error("[RemoteSkillService] " + errorMsg);
                throw new IOException(errorMsg);
            }

            File targetDirFile = new File(targetDir);
            if (!targetDirFile.exists()) {
                targetDirFile.mkdirs();
            }

            // Check if URL is a zip file
            if (url.endsWith(".zip")) {
                // Extract zip
                File skillDir = new File(targetDir, skillName);
                skillDir.mkdirs();

                try (ByteArrayInputStream bais = new ByteArrayInputStream(data);
                     ZipInputStream zis = new ZipInputStream(bais)) {
                    ZipEntry entry;
                    while ((entry = zis.getNextEntry()) != null) {
                        if (entry.isDirectory()) continue;

                        File targetFile = new File(skillDir, entry.getName());
                        targetFile.getParentFile().mkdirs();

                        try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                            byte[] buffer = new byte[8192];
                            int len;
                            while ((len = zis.read(buffer)) > 0) {
                                fos.write(buffer, 0, len);
                            }
                        }
                        zis.closeEntry();
                    }
                }
            } else {
                // Direct .md file - create directory and save as skill.md
                File skillDir = new File(targetDir, skillName);
                skillDir.mkdirs();

                File skillFile = new File(skillDir, "skill.md");
                Files.write(skillFile.toPath(), data);
            }

            // Save remote configuration
            Map<String, RemoteSkillConfig> configs = loadRemoteConfig();
            String configKey = scope + "-" + skillName;

            RemoteSkillConfig config = new RemoteSkillConfig();
            config.name = skillName;
            config.scope = scope;
            config.url = url;
            config.updateInterval = updateInterval;
            config.lastUpdated = System.currentTimeMillis();
            config.nextUpdate = calculateNextUpdate(updateInterval, config.lastUpdated);

            configs.put(configKey, config);
            saveRemoteConfig(configs);

            result.addProperty("success", true);
            result.addProperty("name", skillName);
            result.addProperty("scope", scope);
            LOG.info("[RemoteSkillService] Successfully imported remote skill: " + skillName);
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to import remote skill: " + e.getMessage(), e);
            result.addProperty("success", false);
            result.addProperty("error", e.getMessage());
        }

        return result;
    }

    /**
     * Update remote skill.
     */
    public static JsonObject updateRemoteSkill(String name, String scope, String url, String workspaceRoot) {
        JsonObject result = new JsonObject();

        try {
            // Download updated file
            LOG.info("[RemoteSkillService] Updating skill from: " + url);
            byte[] data = downloadFile(url);

            // Determine target directory
            String targetDir;
            if ("global".equals(scope) || "user".equals(scope)) {
                targetDir = SkillService.getGlobalSkillsDir();
                LOG.info("[RemoteSkillService] Using global skills directory: " + targetDir);
            } else {
                LOG.info("[RemoteSkillService] Using local scope with workspaceRoot: " + workspaceRoot);
                targetDir = SkillService.getLocalSkillsDir(workspaceRoot);
                LOG.info("[RemoteSkillService] Local skills directory: " + targetDir);
            }

            if (targetDir == null) {
                String errorMsg = "Cannot determine target directory for scope=" + scope + ", workspaceRoot=" + workspaceRoot;
                LOG.error("[RemoteSkillService] " + errorMsg);
                throw new IOException(errorMsg);
            }

            File skillDir = new File(targetDir, name);
            if (!skillDir.exists()) {
                throw new IOException("Skill directory not found: " + skillDir.getPath());
            }

            // Delete old files (except .git if present)
            for (File file : skillDir.listFiles()) {
                if (!".git".equals(file.getName())) {
                    deleteRecursively(file);
                }
            }

            // Extract/save new files
            if (url.endsWith(".zip")) {
                try (ByteArrayInputStream bais = new ByteArrayInputStream(data);
                     ZipInputStream zis = new ZipInputStream(bais)) {
                    ZipEntry entry;
                    while ((entry = zis.getNextEntry()) != null) {
                        if (entry.isDirectory()) continue;

                        File targetFile = new File(skillDir, entry.getName());
                        targetFile.getParentFile().mkdirs();

                        try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                            byte[] buffer = new byte[8192];
                            int len;
                            while ((len = zis.read(buffer)) > 0) {
                                fos.write(buffer, 0, len);
                            }
                        }
                        zis.closeEntry();
                    }
                }
            } else {
                File skillFile = new File(skillDir, "skill.md");
                Files.write(skillFile.toPath(), data);
            }

            // Update configuration
            Map<String, RemoteSkillConfig> configs = loadRemoteConfig();
            String configKey = scope + "-" + name;

            if (configs.containsKey(configKey)) {
                RemoteSkillConfig config = configs.get(configKey);
                config.lastUpdated = System.currentTimeMillis();
                config.nextUpdate = calculateNextUpdate(config.updateInterval, config.lastUpdated);
                saveRemoteConfig(configs);
            }

            result.addProperty("success", true);
            result.addProperty("name", name);
            LOG.info("[RemoteSkillService] Successfully updated remote skill: " + name);
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to update remote skill: " + e.getMessage(), e);
            result.addProperty("success", false);
            result.addProperty("error", e.getMessage());
        }

        return result;
    }

    /**
     * Update remote skill update interval.
     */
    public static JsonObject updateRemoteSkillInterval(String name, String scope, String updateInterval) {
        JsonObject result = new JsonObject();

        try {
            Map<String, RemoteSkillConfig> configs = loadRemoteConfig();
            String configKey = scope + "-" + name;

            if (!configs.containsKey(configKey)) {
                throw new IllegalArgumentException("Remote skill not found: " + configKey);
            }

            RemoteSkillConfig config = configs.get(configKey);
            config.updateInterval = updateInterval;
            config.nextUpdate = calculateNextUpdate(updateInterval, config.lastUpdated);

            saveRemoteConfig(configs);

            result.addProperty("success", true);
            result.addProperty("name", name);
            LOG.info("[RemoteSkillService] Updated interval for remote skill: " + name);
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to update interval: " + e.getMessage(), e);
            result.addProperty("success", false);
            result.addProperty("error", e.getMessage());
        }

        return result;
    }

    /**
     * Get remote configuration for a skill.
     */
    public static RemoteSkillConfig getRemoteConfig(String name, String scope) {
        Map<String, RemoteSkillConfig> configs = loadRemoteConfig();
        String configKey = scope + "-" + name;
        return configs.get(configKey);
    }

    /**
     * Calculate next update time based on interval.
     */
    private static long calculateNextUpdate(String interval, long lastUpdated) {
        if ("manual".equals(interval)) {
            return 0;
        }

        long intervalMs;
        switch (interval) {
            case "hourly":
                intervalMs = 60 * 60 * 1000L;
                break;
            case "daily":
                intervalMs = 24 * 60 * 60 * 1000L;
                break;
            case "weekly":
                intervalMs = 7 * 24 * 60 * 60 * 1000L;
                break;
            default:
                return 0;
        }

        return lastUpdated + intervalMs;
    }

    /**
     * Delete file or directory recursively.
     */
    private static void deleteRecursively(File file) throws IOException {
        if (file.isDirectory()) {
            for (File child : file.listFiles()) {
                deleteRecursively(child);
            }
        }
        if (!file.delete()) {
            throw new IOException("Failed to delete: " + file.getPath());
        }
    }

    /**
     * Delete remote skill configuration.
     */
    public static void deleteRemoteConfig(String name, String scope) {
        try {
            Map<String, RemoteSkillConfig> configs = loadRemoteConfig();
            String configKey = scope + "-" + name;
            configs.remove(configKey);
            saveRemoteConfig(configs);
            LOG.info("[RemoteSkillService] Deleted remote config for: " + configKey);
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to delete remote config: " + e.getMessage(), e);
        }
    }

    /**
     * Parse navigation directory from any text content.
     * Extracts all HTTP/HTTPS URLs pointing to .md or .zip files.
     * Supports multiple formats: plain text, Markdown, HTML, etc.
     */
    private static List<NavigationEntry> parseNavigationDirectory(String content) {
        List<NavigationEntry> entries = new ArrayList<>();
        Set<String> seenUrls = new HashSet<>(); // Deduplicate URLs

        try {
            // Pattern to match HTTP/HTTPS URLs
            // Matches: http://... or https://...
            // Stops at whitespace, quotes, parentheses, or angle brackets
            Pattern urlPattern = Pattern.compile(
                "https?://[^\\s<>\"'()\\[\\]{}]+",
                Pattern.CASE_INSENSITIVE
            );

            Matcher matcher = urlPattern.matcher(content);

            while (matcher.find()) {
                String url = matcher.group().trim();

                // Remove trailing punctuation that might be part of markdown/html
                url = url.replaceAll("[.,;:!?\\)\\]]+$", "");

                // Only process URLs ending with .md or .zip (skill files)
                if (!url.toLowerCase().endsWith(".md") && !url.toLowerCase().endsWith(".zip")) {
                    continue;
                }

                // Skip duplicates
                if (seenUrls.contains(url)) {
                    continue;
                }
                seenUrls.add(url);

                NavigationEntry entry = new NavigationEntry();
                entry.url = url;

                // Extract skill name from URL path
                // Example: https://example.com/skills/my-skill.md -> my-skill
                try {
                    String path = url.substring(url.lastIndexOf('/') + 1);
                    if (path.endsWith(".md")) {
                        entry.name = path.substring(0, path.length() - 3);
                    } else if (path.endsWith(".zip")) {
                        entry.name = path.substring(0, path.length() - 4);
                    } else {
                        entry.name = path;
                    }
                    // Sanitize name
                    entry.name = entry.name.replaceAll("[^a-zA-Z0-9._-]", "-").toLowerCase();
                } catch (Exception e) {
                    entry.name = "skill-" + System.currentTimeMillis();
                }

                entries.add(entry);
                LOG.info("[RemoteSkillService] Extracted skill URL: " + entry.name + " -> " + entry.url);
            }

            LOG.info("[RemoteSkillService] Total skill URLs found: " + entries.size());
        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to parse navigation directory: " + e.getMessage(), e);
        }

        return entries;
    }

    /**
     * Import skills from a navigation directory URL.
     * Downloads the navigation file, parses the table, and batch imports all skills.
     */
    public static JsonObject importFromNavigationDirectory(String navUrl, String scope, String updateInterval, String workspaceRoot) {
        JsonObject result = new JsonObject();
        BatchImportResult batchResult = new BatchImportResult();

        try {
            // Download navigation directory file
            LOG.info("[RemoteSkillService] Downloading navigation directory from: " + navUrl);
            byte[] navData = downloadFile(navUrl);
            String navContent = new String(navData, "UTF-8");

            // Parse navigation entries
            List<NavigationEntry> entries = parseNavigationDirectory(navContent);
            batchResult.total = entries.size();

            if (entries.isEmpty()) {
                result.addProperty("success", false);
                result.addProperty("error", "No valid skill links found in navigation directory");
                return result;
            }

            LOG.info("[RemoteSkillService] Found " + entries.size() + " skills in navigation directory");

            // Import each skill
            for (NavigationEntry entry : entries) {
                try {
                    LOG.info("[RemoteSkillService] Batch importing skill: " + entry.name + " from " + entry.url);
                    JsonObject importResult = importRemoteSkill(entry.url, scope, updateInterval, workspaceRoot);

                    if (importResult.get("success").getAsBoolean()) {
                        batchResult.succeeded++;
                        batchResult.successList.add(entry.name);
                        LOG.info("[RemoteSkillService] Successfully imported: " + entry.name);
                    } else {
                        batchResult.failed++;
                        batchResult.failureList.add(entry.name);
                        String error = importResult.has("error") ? importResult.get("error").getAsString() : "Unknown error";
                        batchResult.errorMessages.add(entry.name + ": " + error);
                        LOG.warn("[RemoteSkillService] Failed to import " + entry.name + ": " + error);
                    }
                } catch (Exception e) {
                    batchResult.failed++;
                    batchResult.failureList.add(entry.name);
                    batchResult.errorMessages.add(entry.name + ": " + e.getMessage());
                    LOG.error("[RemoteSkillService] Exception importing " + entry.name + ": " + e.getMessage(), e);
                }
            }

            // Build result
            result.addProperty("success", true);
            result.addProperty("total", batchResult.total);
            result.addProperty("succeeded", batchResult.succeeded);
            result.addProperty("failed", batchResult.failed);

            JsonArray successArray = new JsonArray();
            for (String name : batchResult.successList) {
                successArray.add(name);
            }
            result.add("successList", successArray);

            JsonArray failureArray = new JsonArray();
            for (String name : batchResult.failureList) {
                failureArray.add(name);
            }
            result.add("failureList", failureArray);

            JsonArray errorArray = new JsonArray();
            for (String error : batchResult.errorMessages) {
                errorArray.add(error);
            }
            result.add("errorMessages", errorArray);

            LOG.info("[RemoteSkillService] Batch import completed: " + batchResult.succeeded + " succeeded, "
                    + batchResult.failed + " failed");

        } catch (Exception e) {
            LOG.error("[RemoteSkillService] Failed to import from navigation directory: " + e.getMessage(), e);
            result.addProperty("success", false);
            result.addProperty("error", e.getMessage());
        }

        return result;
    }
}
