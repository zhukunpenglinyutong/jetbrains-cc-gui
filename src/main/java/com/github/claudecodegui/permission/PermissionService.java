package com.github.claudecodegui.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * Permission service - handles permission requests from the Node.js process
 */
public class PermissionService {

    private static final Logger LOG = Logger.getInstance(PermissionService.class);

    private static PermissionService instance;
    private static final Map<String, PermissionService> instancesBySessionId = new ConcurrentHashMap<>();

    // File name pattern constants
    private static final String REQUEST_FILE_PREFIX = "request-%s-%s.json";
    private static final String RESPONSE_FILE_PREFIX = "response-%s-%s.json";
    private static final String ASK_USER_QUESTION_FILE_PREFIX = "ask-user-question-%s-%s.json";
    private static final String ASK_USER_QUESTION_RESPONSE_FILE_PREFIX = "ask-user-question-response-%s-%s.json";
    private static final String PLAN_APPROVAL_FILE_PREFIX = "plan-approval-%s-%s.json";
    private static final String PLAN_APPROVAL_RESPONSE_FILE_PREFIX = "plan-approval-response-%s-%s.json";

    // Session cleanup configuration
    private static final long SESSION_CLEANUP_INTERVAL_MS = TimeUnit.HOURS.toMillis(1);
    private static final long SESSION_MAX_IDLE_TIME_MS = TimeUnit.HOURS.toMillis(24);
    private static volatile long lastCleanupTime = System.currentTimeMillis();

    private final Project project;
    private final Path permissionDir;
    private final String sessionId;
    private final Gson gson = new Gson();
    private WatchService watchService;
    private Thread watchThread;
    private boolean running = false;
    private volatile long lastActivityTime = System.currentTimeMillis();

    // Remember user choices (tool + parameter level)
    private final Map<String, Integer> permissionMemory = new ConcurrentHashMap<>();
    // Tool-level permission memory (tool name only -> always allow or not)
    private final Map<String, Boolean> toolOnlyPermissionMemory = new ConcurrentHashMap<>();
    private volatile PermissionDecisionListener decisionListener;

    // Multi-project support: permission dialog showers registered per project
    private final Map<Project, PermissionDialogShower> dialogShowers = new ConcurrentHashMap<>();

    // Multi-project support: AskUserQuestion dialog showers registered per project
    private final Map<Project, AskUserQuestionDialogShower> askUserQuestionDialogShowers = new ConcurrentHashMap<>();

    // Multi-project support: PlanApproval dialog showers registered per project
    private final Map<Project, PlanApprovalDialogShower> planApprovalDialogShowers = new ConcurrentHashMap<>();

    // Most recently active project (used for dialog selection when no file context is available)
    private volatile Project lastActiveProject = null;

    // File wait configuration
    private static final int FILE_WAIT_INITIAL_DELAY_MS = 50;
    private static final int FILE_WAIT_MAX_RETRIES = 3;

    // Debug logging helper methods
    private void debugLog(String tag, String message) {
        LOG.debug(String.format("[%s] %s", tag, message));
    }

    private void debugLog(String tag, String message, Object data) {
        LOG.debug(String.format("[%s] %s | Data: %s", tag, message, this.gson.toJson(data)));
    }

    public enum PermissionResponse {
        ALLOW(1, "Allow"),
        ALLOW_ALWAYS(2, "Allow and don't ask again"),
        DENY(3, "Deny");

        private final int value;
        private final String description;

        PermissionResponse(int value, String description) {
            this.value = value;
            this.description = description;
        }

        public int getValue() {
            return value;
        }

        public String getDescription() {
            return description;
        }

        public static PermissionResponse fromValue(int value) {
            for (PermissionResponse response : values()) {
                if (response.value == value) {
                    return response;
                }
            }
            return null;
        }

        public boolean isAllow() {
            return this == ALLOW || this == ALLOW_ALWAYS;
        }
    }

    public static class PermissionDecision {
        private final String toolName;
        private final JsonObject inputs;
        private final PermissionResponse response;

        public PermissionDecision(String toolName, JsonObject inputs, PermissionResponse response) {
            this.toolName = toolName;
            this.inputs = inputs;
            this.response = response;
        }

        public String getToolName() {
            return toolName;
        }

        public JsonObject getInputs() {
            return inputs;
        }

        public PermissionResponse getResponse() {
            return response;
        }

        public boolean isAllowed() {
            return response != null && response.isAllow();
        }
    }

    public interface PermissionDecisionListener {
        void onDecision(PermissionDecision decision);
    }

    /**
     * Permission dialog shower interface - used to display frontend popups
     */
    public interface PermissionDialogShower {
        /**
         * Show a permission dialog and return the user's decision
         * @param toolName the tool name
         * @param inputs the input parameters
         * @return CompletableFuture<Integer> resolving to a PermissionResponse value
         */
        CompletableFuture<Integer> showPermissionDialog(String toolName, JsonObject inputs);
    }

    /**
     * AskUserQuestion dialog shower interface - used to display question dialogs
     */
    public interface AskUserQuestionDialogShower {
        /**
         * Show an AskUserQuestion dialog and return the user's answers
         * @param requestId the request ID
         * @param questions the list of questions (JSON array)
         * @return CompletableFuture<JsonObject> resolving to user answers (format: { "question text": "answer" })
         */
        CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questions);
    }

    /**
     * PlanApproval dialog shower interface - used to display plan approval dialogs
     */
    public interface PlanApprovalDialogShower {
        /**
         * Show a plan approval dialog and return the user's decision
         * @param requestId the request ID
         * @param planData the plan data (containing allowedPrompts, etc.)
         * @return CompletableFuture<JsonObject> resolving to user decision (format: { "approved": boolean, "targetMode": string })
         */
        CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData);
    }

    private PermissionService(Project project, String sessionId) {
        this.project = project;
        this.sessionId = sessionId;

        // Unified permission communication directory:
        // 1. Prefer the CLAUDE_PERMISSION_DIR environment variable (injected by Java when launching the Node process)
        // 2. Fall back to the system temp directory {java.io.tmpdir}/claude-permission
        // No longer uses ~/.claude/permission to avoid path mismatch with the Node side's default /tmp path
        String envDir = System.getenv("CLAUDE_PERMISSION_DIR");
        if (envDir != null && !envDir.trim().isEmpty()) {
            this.permissionDir = Paths.get(envDir);
            debugLog("INIT", "Using permission dir from env CLAUDE_PERMISSION_DIR: " + envDir);
        } else {
            this.permissionDir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
            debugLog("INIT", "Env CLAUDE_PERMISSION_DIR not set, using tmp dir: " + this.permissionDir);
        }
        debugLog("INIT", "Session ID: " + this.sessionId);
        try {
            Files.createDirectories(permissionDir);
            debugLog("INIT", "Permission directory created/verified: " + permissionDir);
        } catch (IOException e) {
            debugLog("INIT_ERROR", "Failed to create permission dir: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    public String getSessionId() {
        return this.sessionId;
    }

    /**
     * Get or create PermissionService instance for the specified project and session.
     * This is the recommended method for multi-window scenarios.
     *
     * @param project the project
     * @param sessionId the session ID (should be unique per IDE instance)
     * @return PermissionService instance
     */
    public static synchronized PermissionService getInstance(Project project, String sessionId) {
        // Periodically clean up expired session instances
        cleanupStaleInstancesIfNeeded();

        // Manage multiple instances by sessionId instead of a global singleton
        if (sessionId == null || sessionId.isEmpty()) {
            // Backward compatibility: if no sessionId, use the global singleton (deprecated)
            if (instance == null) {
                instance = new PermissionService(project, java.util.UUID.randomUUID().toString());
            }
            return instance;
        }

        // Create or return the instance corresponding to each sessionId
        return instancesBySessionId.computeIfAbsent(sessionId, sid ->
            new PermissionService(project, sid)
        );
    }

    /**
     * Remove the PermissionService instance for the specified sessionId.
     * Called when a project is closed to prevent memory leaks.
     *
     * @param sessionId Session ID
     */
    public static synchronized void removeInstance(String sessionId) {
        if (sessionId != null && !sessionId.isEmpty()) {
            PermissionService removed = instancesBySessionId.remove(sessionId);
            if (removed != null) {
                removed.stop();
                LOG.info(String.format("PermissionService instance removed for sessionId=%s, remaining instances=%d",
                    sessionId, instancesBySessionId.size()));
            }
        }
    }

    /**
     * Get PermissionService instance for the specified project (deprecated).
     * Please use getInstance(Project, String) instead to support multi-window scenarios.
     *
     * @param project the project
     * @return PermissionService instance
     * @deprecated Use {@link #getInstance(Project, String)} instead. This method will be removed in version 0.2.0.
     */
    @Deprecated(since = "0.1.6", forRemoval = true)
    public static synchronized PermissionService getInstance(Project project) {
        LOG.warn("Deprecated getInstance(Project) called - please migrate to getInstance(Project, String sessionId). " +
            "This method will be removed in a future version.");
        if (instance == null) {
            instance = new PermissionService(project, java.util.UUID.randomUUID().toString());
        }
        return instance;
    }

    /**
     * Periodically clean up stale session instances to prevent memory leaks.
     * Sessions idle for more than 24 hours are automatically removed.
     */
    private static synchronized void cleanupStaleInstancesIfNeeded() {
        long now = System.currentTimeMillis();
        if (now - lastCleanupTime < SESSION_CLEANUP_INTERVAL_MS) {
            return;
        }

        lastCleanupTime = now;

        // Collect sessions to clean up, avoiding ConcurrentModificationException
        List<String> sessionsToRemove = new ArrayList<>();
        for (Map.Entry<String, PermissionService> entry : instancesBySessionId.entrySet()) {
            PermissionService service = entry.getValue();
            if (now - service.lastActivityTime > SESSION_MAX_IDLE_TIME_MS) {
                LOG.info(String.format("Marking stale session for cleanup: %s (idle for %d hours)",
                    entry.getKey(), (now - service.lastActivityTime) / 3600000));
                sessionsToRemove.add(entry.getKey());
            }
        }

        // Batch cleanup
        for (String sessionId : sessionsToRemove) {
            PermissionService service = instancesBySessionId.remove(sessionId);
            if (service != null) {
                service.stop();
            }
        }

        if (!sessionsToRemove.isEmpty()) {
            LOG.info(String.format("Cleaned up %d stale session(s), remaining instances=%d",
                sessionsToRemove.size(), instancesBySessionId.size()));
        }
    }

    public void setDecisionListener(PermissionDecisionListener listener) {
        this.decisionListener = listener;
        debugLog("CONFIG", "Decision listener set: " + (listener != null));
    }

    /**
     * Register a permission dialog shower (used to display frontend popups).
     * Supports multi-project: each project registers its own shower.
     *
     * @param project the project
     * @param shower the permission dialog shower
     */
    public void registerDialogShower(Project project, PermissionDialogShower shower) {
        if (project != null && shower != null) {
            dialogShowers.put(project, shower);
            lastActiveProject = project; // Track most recent active project
            debugLog("CONFIG", "Dialog shower registered for project: " + project.getName() +
                ", total registered: " + dialogShowers.size());
        }
    }

    /**
     * Unregister a permission dialog shower.
     * Called when a project is closed to prevent memory leaks.
     *
     * @param project the project
     */
    public void unregisterDialogShower(Project project) {
        if (project != null) {
            PermissionDialogShower removed = dialogShowers.remove(project);
            debugLog("CONFIG", "Dialog shower unregistered for project: " + project.getName() +
                ", was registered: " + (removed != null) + ", remaining: " + dialogShowers.size());
        }
    }

    /**
     * Register an AskUserQuestion dialog shower.
     * Supports multi-project: each project registers its own shower.
     *
     * @param project the project
     * @param shower the AskUserQuestion dialog shower
     */
    public void registerAskUserQuestionDialogShower(Project project, AskUserQuestionDialogShower shower) {
        if (project != null && shower != null) {
            askUserQuestionDialogShowers.put(project, shower);
            lastActiveProject = project; // Track most recent active project
            debugLog("CONFIG", "AskUserQuestion dialog shower registered for project: " + project.getName() +
                ", total registered: " + askUserQuestionDialogShowers.size());
        }
    }

    /**
     * Unregister an AskUserQuestion dialog shower.
     * Called when a project is closed to prevent memory leaks.
     *
     * @param project the project
     */
    public void unregisterAskUserQuestionDialogShower(Project project) {
        if (project != null) {
            AskUserQuestionDialogShower removed = askUserQuestionDialogShowers.remove(project);
            debugLog("CONFIG", "AskUserQuestion dialog shower unregistered for project: " + project.getName() +
                ", was registered: " + (removed != null) + ", remaining: " + askUserQuestionDialogShowers.size());
        }
    }

    /**
     * Register a PlanApproval dialog shower.
     * Supports multi-project: each project registers its own shower.
     *
     * @param project the project
     * @param shower the PlanApproval dialog shower
     */
    public void registerPlanApprovalDialogShower(Project project, PlanApprovalDialogShower shower) {
        if (project != null && shower != null) {
            planApprovalDialogShowers.put(project, shower);
            lastActiveProject = project; // Track most recent active project
            debugLog("CONFIG", "PlanApproval dialog shower registered for project: " + project.getName() +
                ", total registered: " + planApprovalDialogShowers.size());
        }
    }

    /**
     * Update the last active project (called when user interacts with a project)
     * @param project The project that became active
     */
    public void setLastActiveProject(Project project) {
        if (project != null) {
            this.lastActiveProject = project;
            debugLog("CONFIG", "Last active project updated: " + project.getName());
        }
    }

    /**
     * Get dialog shower with preference for last active project
     * Falls back to first registered shower if last active project has no shower
     */
    private <T> T getPreferredDialogShower(Map<Project, T> showers) {
        if (showers.isEmpty()) {
            return null;
        }
        // Prefer the last active project's shower
        if (lastActiveProject != null && showers.containsKey(lastActiveProject)) {
            return showers.get(lastActiveProject);
        }
        // Fallback to first registered shower
        return showers.values().iterator().next();
    }

    /**
     * Wait for file to be ready with retry mechanism
     * Uses exponential backoff for more reliable file system synchronization
     */
    private boolean waitForFileReady(Path file) {
        int delay = FILE_WAIT_INITIAL_DELAY_MS;
        for (int i = 0; i < FILE_WAIT_MAX_RETRIES; i++) {
            try {
                Thread.sleep(delay);
                if (Files.exists(file) && Files.size(file) > 0) {
                    return true;
                }
                delay *= 2; // Exponential backoff
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            } catch (IOException e) {
                debugLog("FILE_WAIT", "Error checking file: " + e.getMessage());
            }
        }
        return Files.exists(file);
    }

    /**
     * Unregister a PlanApproval dialog shower.
     * Called when a project is closed to prevent memory leaks.
     *
     * @param project the project
     */
    public void unregisterPlanApprovalDialogShower(Project project) {
        if (project != null) {
            PlanApprovalDialogShower removed = planApprovalDialogShowers.remove(project);
            debugLog("CONFIG", "PlanApproval dialog shower unregistered for project: " + project.getName() +
                ", was registered: " + (removed != null) + ", remaining: " + planApprovalDialogShowers.size());
        }
    }

    /**
     * Set the permission dialog shower (used to display frontend popups).
     * @deprecated Use {@link #registerDialogShower(Project, PermissionDialogShower)} instead.
     */
    @Deprecated
    public void setDialogShower(PermissionDialogShower shower) {
        // Backward compatibility: register with the default project
        if (shower != null && this.project != null) {
            dialogShowers.put(this.project, shower);
        }
        debugLog("CONFIG", "Dialog shower set (legacy): " + (shower != null));
    }

    /**
     * Generic method to match a project by working directory.
     * Extracts cwd from the request and finds the corresponding project.
     *
     * @param request the request data (containing a cwd field)
     * @param dialogShowers the map of registered DialogShowers
     * @param logPrefix the log prefix, used to distinguish different request types
     * @param <T> the DialogShower type
     * @return the DialogShower for the matched project, or the lastActiveProject's shower as fallback
     */
    private <T> T findDialogShowerByCwd(
            JsonObject request,
            Map<Project, T> dialogShowers,
            String logPrefix) {
        if (dialogShowers.isEmpty()) {
            debugLog(logPrefix, "No dialog showers registered");
            return null;
        }

        // If only one project is registered, return it directly
        if (dialogShowers.size() == 1) {
            Map.Entry<Project, T> entry = dialogShowers.entrySet().iterator().next();
            debugLog(logPrefix, "Single project registered: " + entry.getKey().getName());
            return entry.getValue();
        }

        // Extract cwd from the request
        String cwd = null;
        if (request.has("cwd") && !request.get("cwd").isJsonNull()) {
            cwd = request.get("cwd").getAsString();
        }

        if (cwd == null || cwd.isEmpty()) {
            debugLog(logPrefix, "No cwd found in request, using preferred dialog shower");
            return getPreferredDialogShower(dialogShowers);
        }

        // Normalize the cwd path
        String normalizedCwd = normalizePath(cwd);
        debugLog(logPrefix, "Extracted cwd: " + cwd +
            (cwd.equals(normalizedCwd) ? "" : " (normalized: " + normalizedCwd + ")"));

        // Iterate over all projects and find the path match (prefer the longest match)
        Project bestMatch = null;
        int longestMatchLength = 0;

        for (Map.Entry<Project, T> entry : dialogShowers.entrySet()) {
            Project project = entry.getKey();
            String projectPath = project.getBasePath();

            if (projectPath != null) {
                String normalizedProjectPath = normalizePath(projectPath);

                // Check if cwd is under the project path
                if (isFileInProject(normalizedCwd, normalizedProjectPath)) {
                    if (normalizedProjectPath.length() > longestMatchLength) {
                        longestMatchLength = normalizedProjectPath.length();
                        bestMatch = project;
                        debugLog(logPrefix, "Found potential match: " + project.getName() +
                            " (path: " + projectPath + ", length: " + normalizedProjectPath.length() + ")");
                    }
                }
            }
        }

        if (bestMatch != null) {
            debugLog(logPrefix, "Matched project: " + bestMatch.getName() +
                " (path: " + bestMatch.getBasePath() + ")");
            return dialogShowers.get(bestMatch);
        }

        // No match found, fall back to lastActiveProject
        debugLog(logPrefix, "No matching project found, using preferred dialog shower");
        return getPreferredDialogShower(dialogShowers);
    }

    /**
     * Match a project by working directory.
     * Extracts cwd from the AskUserQuestion request and finds the corresponding project.
     *
     * @param request the AskUserQuestion request data
     * @return the DialogShower for the matched project, or the lastActiveProject's shower as fallback
     */
    private AskUserQuestionDialogShower findAskUserQuestionDialogShowerByCwd(JsonObject request) {
        return findDialogShowerByCwd(request, askUserQuestionDialogShowers, "MATCH_ASK_PROJECT");
    }

    /**
     * Match a project by working directory.
     * Extracts cwd from the PlanApproval request and finds the corresponding project.
     *
     * @param request the PlanApproval request data
     * @return the DialogShower for the matched project, or the lastActiveProject's shower as fallback
     */
    private PlanApprovalDialogShower findPlanApprovalDialogShowerByCwd(JsonObject request) {
        return findDialogShowerByCwd(request, planApprovalDialogShowers, "MATCH_PLAN_PROJECT");
    }

    /**
     * Extract a file path from inputs.
     * Supports multiple fields: file_path, path, paths within command, etc.
     */
    private String extractFilePathFromInputs(JsonObject inputs) {
        if (inputs == null) {
            return null;
        }

        // Check file_path field first (most common)
        if (inputs.has("file_path") && !inputs.get("file_path").isJsonNull()) {
            return inputs.get("file_path").getAsString();
        }

        // Check path field
        if (inputs.has("path") && !inputs.get("path").isJsonNull()) {
            return inputs.get("path").getAsString();
        }

        // Check notebook_path field (Jupyter notebooks)
        if (inputs.has("notebook_path") && !inputs.get("notebook_path").isJsonNull()) {
            return inputs.get("notebook_path").getAsString();
        }

        // Extract path from command field (attempt to find an absolute path)
        if (inputs.has("command") && !inputs.get("command").isJsonNull()) {
            String command = inputs.get("command").getAsString();
            // Simple path extraction: look for paths starting with / (Unix) or containing :\ (Windows)
            String[] parts = command.split("\\s+");
            for (String part : parts) {
                if (part.startsWith("/") || (part.length() > 2 && part.charAt(1) == ':')) {
                    // Strip potential surrounding quotes
                    part = part.replace("\"", "").replace("'", "");
                    if (part.length() > 1) {
                        return part;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Normalize a file path.
     * Unifies path separators to Unix style (/) for cross-platform compatibility.
     *
     * @param path the original path
     * @return the normalized path, or null if the input is null
     */
    private String normalizePath(String path) {
        if (path == null) {
            return null;
        }
        // Replace Windows-style backslashes with forward slashes
        return path.replace('\\', '/');
    }

    /**
     * Check if a file path belongs to a project path.
     * Ensures the match is a full path prefix, not just a string prefix.
     *
     * Examples:
     * - /home/user/my-app/file.txt belongs to /home/user/my-app (true)
     * - /home/user/my-app-v2/file.txt does NOT belong to /home/user/my-app (true)
     *
     * @param filePath the file path (already normalized)
     * @param projectPath the project path (already normalized)
     * @return true if the file belongs to the project
     */
    private boolean isFileInProject(String filePath, String projectPath) {
        if (filePath == null || projectPath == null) {
            return false;
        }

        // Exact match case
        if (filePath.equals(projectPath)) {
            return true;
        }

        // Ensure projectPath ends with a separator to avoid false prefix matches
        // e.g., /home/user/my-app/ instead of /home/user/my-app
        String normalizedProjectPath = projectPath.endsWith("/")
            ? projectPath
            : projectPath + "/";

        // Check if the file path starts with "projectPath/"
        return filePath.startsWith(normalizedProjectPath);
    }

    /**
     * Start the permission service.
     */
    public void start() {
        if (running) {
            debugLog("START", "Already running, skipping start");
            return;
        }

        // Clean up old response files to avoid accidental processing
        cleanupOldResponseFiles();

        this.running = true;
        this.lastActivityTime = System.currentTimeMillis(); // Update activity time

        this.watchThread = new Thread(this::watchLoop, "PermissionWatcher");
        this.watchThread.setDaemon(true);
        this.watchThread.start();

        debugLog("START", "Started polling on: " + this.permissionDir);
    }

    /**
     * Clean up old response and request files (only files belonging to this session).
     */
    private void cleanupOldResponseFiles() {
        try {
            File dir = permissionDir.toFile();
            if (!dir.exists()) {
                return;
            }

            // Clean up permission response files (only for this session)
            File[] responseFiles = dir.listFiles((d, name) ->
                name.startsWith("response-" + sessionId + "-") && name.endsWith(".json"));
            if (responseFiles != null) {
                for (File file : responseFiles) {
                    try {
                        Files.delete(file.toPath());
                        debugLog("CLEANUP", "Deleted old response file: " + file.getName());
                    } catch (Exception e) {
                        debugLog("CLEANUP_ERROR", "Failed to delete response file: " + file.getName());
                    }
                }
            }

            // Clean up permission request files (only for this session)
            File[] requestFiles = dir.listFiles((d, name) ->
                name.startsWith("request-" + sessionId + "-") && name.endsWith(".json"));
            if (requestFiles != null) {
                for (File file : requestFiles) {
                    try {
                        Files.delete(file.toPath());
                        debugLog("CLEANUP", "Deleted old request file: " + file.getName());
                    } catch (Exception e) {
                        debugLog("CLEANUP_ERROR", "Failed to delete request file: " + file.getName());
                    }
                }
            }

            // Clean up all AskUserQuestion-related files (only for this session)
            File[] askFiles = dir.listFiles((d, name) ->
                name.startsWith("ask-user-question-" + sessionId + "-") && name.endsWith(".json"));
            if (askFiles != null) {
                for (File file : askFiles) {
                    try {
                        Files.delete(file.toPath());
                        debugLog("CLEANUP", "Deleted old AskUserQuestion file: " + file.getName());
                    } catch (Exception e) {
                        debugLog("CLEANUP_ERROR", "Failed to delete AskUserQuestion file: " + file.getName());
                    }
                }
            }

            // Clean up all PlanApproval-related files (only for this session)
            File[] planApprovalFiles = dir.listFiles((d, name) ->
                name.startsWith("plan-approval-" + sessionId + "-") && name.endsWith(".json"));
            if (planApprovalFiles != null) {
                for (File file : planApprovalFiles) {
                    try {
                        Files.delete(file.toPath());
                        debugLog("CLEANUP", "Deleted old PlanApproval file: " + file.getName());
                    } catch (Exception e) {
                        debugLog("CLEANUP_ERROR", "Failed to delete PlanApproval file: " + file.getName());
                    }
                }
            }

            debugLog("CLEANUP", "Session-specific permission files cleanup complete");
        } catch (Exception e) {
            debugLog("CLEANUP_ERROR", "Error during cleanup: " + e.getMessage());
        }
    }

    /**
     * Watch for file changes.
     * Uses polling mode for better reliability on macOS /tmp directories.
     */
    private void watchLoop() {
        debugLog("WATCH_LOOP", "Starting polling loop on: " + permissionDir);
        int pollCount = 0;
        while (running) {
            try {
                pollCount++;
                File dir = permissionDir.toFile();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                // Monitor permission request files (only process files containing this session ID)
                File[] requestFiles = dir.listFiles((d, name) ->
                    name.startsWith("request-" + sessionId + "-") && name.endsWith(".json"));

                // Monitor AskUserQuestion request files (exclude response files, only process this session)
                File[] askUserQuestionFiles = dir.listFiles((d, name) ->
                    name.startsWith("ask-user-question-" + sessionId + "-") &&
                    !name.startsWith("ask-user-question-response-") &&
                    name.endsWith(".json"));

                // Monitor PlanApproval request files (exclude response files, only process this session)
                File[] planApprovalFiles = dir.listFiles((d, name) ->
                    name.startsWith("plan-approval-" + sessionId + "-") &&
                    !name.startsWith("plan-approval-response-") &&
                    name.endsWith(".json"));

                // Log status periodically (every 100 polls, ~50 seconds)
                // Reduced logging frequency from every 20 polls (~10s) for less noise
                if (pollCount % 100 == 0) {
                    int requestCount = requestFiles != null ? requestFiles.length : 0;
                    int askQuestionCount = askUserQuestionFiles != null ? askUserQuestionFiles.length : 0;
                    int planApprovalCount = planApprovalFiles != null ? planApprovalFiles.length : 0;
                    debugLog("POLL_STATUS", String.format("Poll #%d, found %d request files, %d ask-user-question files, %d plan-approval files",
                        pollCount, requestCount, askQuestionCount, planApprovalCount));
                }

                // Process permission requests
                if (requestFiles != null && requestFiles.length > 0) {
                    for (File file : requestFiles) {
                        // Simple deduplication: check if the file still exists (may have been handled by another thread)
                        if (file.exists()) {
                            debugLog("REQUEST_FOUND", "Found request file: " + file.getName());
                            handlePermissionRequest(file.toPath());
                        }
                    }
                }

                // Process AskUserQuestion requests
                if (askUserQuestionFiles != null && askUserQuestionFiles.length > 0) {
                    for (File file : askUserQuestionFiles) {
                        if (file.exists()) {
                            debugLog("ASK_USER_QUESTION_FOUND", "Found AskUserQuestion file: " + file.getName());
                            handleAskUserQuestionRequest(file.toPath());
                        }
                    }
                }

                // Process PlanApproval requests
                if (planApprovalFiles != null && planApprovalFiles.length > 0) {
                    for (File file : planApprovalFiles) {
                        if (file.exists()) {
                            debugLog("PLAN_APPROVAL_FOUND", "Found PlanApproval file: " + file.getName());
                            handlePlanApprovalRequest(file.toPath());
                        }
                    }
                }

                // Polling interval: 500ms
                Thread.sleep(500);
            } catch (Exception e) {
                debugLog("POLL_ERROR", "Error in poll loop: " + e.getMessage());
                LOG.error("Error occurred", e);
                try {
                    Thread.sleep(1000); // Brief wait after an error
                } catch (InterruptedException ex) {
                    break;
                }
            }
        }
        debugLog("WATCH_LOOP", "Polling loop ended");
    }

    // Track request files currently being processed to avoid duplicate handling
    private final Set<String> processingRequests = ConcurrentHashMap.newKeySet();

    /**
     * Handle a permission request.
     */
    private void handlePermissionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        this.lastActivityTime = startTime; // Update activity time
        debugLog("HANDLE_REQUEST", "Processing request file: " + fileName);

        // Check if this request is already being processed
        if (!processingRequests.add(fileName)) {
            debugLog("SKIP_DUPLICATE", "Request already being processed, skipping: " + fileName);
            return;
        }

        try {
            Thread.sleep(100); // Wait for file write to complete

            if (!Files.exists(requestFile)) {
                debugLog("FILE_MISSING", "Request file missing before read, likely already handled: " + fileName);
                return;
            }

            String content;
            try {
                content = Files.readString(requestFile);
            } catch (NoSuchFileException e) {
                debugLog("FILE_MISSING", "Request file missing while reading, likely already handled: " + fileName);
                return;
            }
            debugLog("FILE_READ", "Read request content: " + content.substring(0, Math.min(200, content.length())) + "...");

            JsonObject request = gson.fromJson(content, JsonObject.class);

            String requestId = request.get("requestId").getAsString();
            String toolName = request.get("toolName").getAsString();
            JsonObject inputs = request.get("inputs").getAsJsonObject();

            debugLog("REQUEST_PARSED", String.format("requestId=%s, toolName=%s", requestId, toolName));

            // First check tool-level permission memory (always allow)
            if (toolOnlyPermissionMemory.containsKey(toolName)) {
                boolean allow = toolOnlyPermissionMemory.get(toolName);
                debugLog("MEMORY_HIT", "Using tool-level memory for " + toolName + " -> " + (allow ? "ALLOW" : "DENY"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, allow ? PermissionResponse.ALLOW_ALWAYS : PermissionResponse.DENY);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // Generate memory key (tool + parameters)
            String memoryKey = toolName + ":" + inputs.toString().hashCode();
            debugLog("MEMORY_KEY", "Generated memory key: " + memoryKey);

            // Check if there is a remembered choice (tool + parameter level)
            if (permissionMemory.containsKey(memoryKey)) {
                int memorized = permissionMemory.get(memoryKey);
                PermissionResponse rememberedResponse = PermissionResponse.fromValue(memorized);
                boolean allow = rememberedResponse != PermissionResponse.DENY;
                debugLog("PARAM_MEMORY_HIT", "Using param-level memory: " + memoryKey + " -> " + (allow ? "ALLOW" : "DENY"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, rememberedResponse);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // Match the project by working directory and find the corresponding frontend dialog shower (supports multiple IDEA instances)
            PermissionDialogShower matchedDialogShower = findDialogShowerByCwd(request, dialogShowers, "MATCH_PROJECT");

            // If a frontend dialog shower is available, use async processing
            if (matchedDialogShower != null) {
                debugLog("DIALOG_SHOWER", "Using frontend dialog for: " + toolName);

                // Delete the request file immediately to prevent duplicate processing
                try {
                    Files.deleteIfExists(requestFile);
                    debugLog("FILE_DELETE", "Deleted request file: " + fileName);
                } catch (Exception e) {
                    debugLog("FILE_DELETE_ERROR", "Failed to delete request file: " + e.getMessage());
                }

                final String memKey = memoryKey;
                final String tool = toolName;
                final long dialogStartTime = System.currentTimeMillis();

                // Asynchronously invoke the frontend dialog
                debugLog("DIALOG_SHOW", "Calling dialogShower.showPermissionDialog for: " + toolName);
                CompletableFuture<Integer> future = matchedDialogShower.showPermissionDialog(toolName, inputs);

                // Process the result asynchronously
                future.thenAccept(response -> {
                    long dialogElapsed = System.currentTimeMillis() - dialogStartTime;
                    LOG.info("[PERM_FUTURE] thenAccept called: response=" + response + ", dialogElapsed=" + dialogElapsed + "ms, tool=" + tool);
                    try {
                        PermissionResponse decision = PermissionResponse.fromValue(response);
                        if (decision == null) {
                            LOG.warn("[PERM_FUTURE] Response value " + response + " mapped to null, defaulting to DENY");
                            decision = PermissionResponse.DENY;
                        }

                        boolean allow;
                        switch (decision) {
                            case ALLOW:
                                allow = true;
                                LOG.info("[PERM_FUTURE] Decision: ALLOW for " + tool);
                                break;
                            case ALLOW_ALWAYS:
                                allow = true;
                                // Save to tool-level permission memory (by tool type, not by parameters)
                                toolOnlyPermissionMemory.put(tool, true);
                                LOG.info("[PERM_FUTURE] Decision: ALLOW_ALWAYS for " + tool + ", saved to memory");
                                break;
                            case DENY:
                            default:
                                allow = false;
                                LOG.info("[PERM_FUTURE] Decision: DENY for " + tool);
                                break;
                        }

                        notifyDecision(toolName, inputs, decision);
                        LOG.info("[PERM_FUTURE] About to writeResponse for requestId=" + requestId + ", allow=" + allow);
                        writeResponse(requestId, allow);

                        LOG.info("[PERM_FUTURE] Dialog processing complete for " + tool);
                    } catch (Exception e) {
                        LOG.error("[PERM_FUTURE] Error in thenAccept callback: " + e.getMessage(), e);
                    } finally {
                        processingRequests.remove(fileName);
                    }
                }).exceptionally(ex -> {
                    LOG.error("[PERM_FUTURE] exceptionally called: " + ex.getMessage(), ex);
                    try {
                        writeResponse(requestId, false);
                    } catch (Exception e) {
                        LOG.error("Error occurred", e);
                    }
                    notifyDecision(toolName, inputs, PermissionResponse.DENY);
                    processingRequests.remove(fileName);
                    return null;
                });

                // Async processing, return immediately without blocking
                return;
            }

            // Fallback: use system dialog (synchronous blocking)
            debugLog("FALLBACK_DIALOG", "Using system dialog (JOptionPane) for: " + toolName);
            CompletableFuture<Integer> future = new CompletableFuture<>();
            ApplicationManager.getApplication().invokeLater(() -> {
                int response = showSystemPermissionDialog(toolName, inputs);
                future.complete(response);
            });

            debugLog("DIALOG_WAIT", "Waiting for system dialog response (timeout: 30s)");
            int response = future.get(30, TimeUnit.SECONDS);
            debugLog("DIALOG_RESPONSE", "Got system dialog response: " + response);

            PermissionResponse decision = PermissionResponse.fromValue(response);
            if (decision == null) {
                debugLog("RESPONSE_NULL", "Response mapped to null, defaulting to DENY");
                decision = PermissionResponse.DENY;
            }

            boolean allow;
            switch (decision) {
                case ALLOW:
                    allow = true;
                    break;
                case ALLOW_ALWAYS:
                    allow = true;
                    permissionMemory.put(memoryKey, PermissionResponse.ALLOW_ALWAYS.value);
                    debugLog("MEMORY_SAVE", "Saved param-level memory: " + memoryKey);
                    break;
                case DENY:
                default:
                    allow = false;
                    break;
            }

            notifyDecision(toolName, inputs, decision);

            // Write the response
            debugLog("WRITE_RESPONSE", String.format("Writing response for %s: allow=%s", requestId, allow));
            writeResponse(requestId, allow);

            // Delete the request file
            Files.delete(requestFile);
            debugLog("FILE_DELETE", "Deleted request file after processing: " + fileName);

            long elapsed = System.currentTimeMillis() - startTime;
            debugLog("REQUEST_COMPLETE", String.format("Request %s completed in %dms", requestId, elapsed));

        } catch (Exception e) {
            debugLog("HANDLE_ERROR", "Error handling request: " + e.getMessage());
            LOG.error("Error occurred", e);
        } finally {
            processingRequests.remove(fileName);
        }
    }

    /**
     * Show a system permission dialog (JOptionPane) - fallback approach.
     */
    private int showSystemPermissionDialog(String toolName, JsonObject inputs) {
        // Build message content
        StringBuilder message = new StringBuilder();
        message.append("Claude requests to perform the following action:\n\n");
        message.append("Tool: ").append(toolName).append("\n");

        // Show important parameters
        if (inputs.has("file_path")) {
            message.append("File: ").append(inputs.get("file_path").getAsString()).append("\n");
        }
        if (inputs.has("command")) {
            message.append("Command: ").append(inputs.get("command").getAsString()).append("\n");
        }

        message.append("\nAllow this action?");

        // Create options
        Object[] options = {
            "Allow",
            "Deny"
        };

        // Show dialog
        int result = JOptionPane.showOptionDialog(
            null,
            message.toString(),
            "Permission Request - " + toolName,
            JOptionPane.DEFAULT_OPTION,
            JOptionPane.QUESTION_MESSAGE,
            null,
            options,
            options[0]
        );

        if (result == 0) {
            return PermissionResponse.ALLOW.getValue();
        }
        return PermissionResponse.DENY.getValue();
    }

    /**
     * Write a response file.
     */
    private void writeResponse(String requestId, boolean allow) {
        LOG.info("[PERM_WRITE] Writing response for requestId=" + requestId + ", allow=" + allow);
        try {
            JsonObject response = new JsonObject();
            response.addProperty("allow", allow);

            String fileName = String.format(RESPONSE_FILE_PREFIX, this.sessionId, requestId);
            Path responseFile = this.permissionDir.resolve(fileName);
            String responseContent = this.gson.toJson(response);
            debugLog("RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // Verify the file was written successfully
            if (Files.exists(responseFile)) {
                long fileSize = Files.size(responseFile);
                LOG.info("[PERM_WRITE] Response file written successfully: " + responseFile + ", size=" + fileSize + " bytes");
            } else {
                LOG.error("[PERM_WRITE] Response file does NOT exist after write: " + responseFile);
            }
        } catch (IOException e) {
            LOG.error("[PERM_WRITE] Failed to write response file: " + e.getMessage(), e);
        }
    }

    /**
     * Handle an AskUserQuestion request.
     *
     * Critical fix note:
     * Original issue: The 500ms polling interval caused the same request file to be detected
     * multiple times before the user could respond to the async dialog (which may take seconds).
     * This led to: (1) multiple showAskUserQuestionDialog calls queuing up in the frontend,
     * (2) after the first response the request file was deleted and the response written,
     * (3) subsequent queued requests still showed dialogs but the pendingRequest no longer existed.
     *
     * Fix: Delete the request file immediately after reading its content, then proceed with async processing.
     */
    private void handleAskUserQuestionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        debugLog("HANDLE_ASK_USER_QUESTION", "Processing AskUserQuestion file: " + fileName);

        // Check if this request is already being processed (deduplicated by filename)
        if (!processingRequests.add(fileName)) {
            debugLog("SKIP_DUPLICATE_ASK", "AskUserQuestion already being processed, skipping: " + fileName);
            return;
        }

        String content;
        try {
            Thread.sleep(100); // Wait for file write to complete

            if (!Files.exists(requestFile)) {
                debugLog("ASK_FILE_MISSING", "AskUserQuestion file missing before read, likely already handled: " + fileName);
                processingRequests.remove(fileName);
                return;
            }

            // Read file content
            content = Files.readString(requestFile);
            debugLog("ASK_FILE_READ", "Read AskUserQuestion content: " + content.substring(0, Math.min(200, content.length())) + "...");

            // Critical fix: delete the request file immediately after reading to prevent duplicate polling
            // Must delete before parsing and async invocation since the polling interval is only 500ms
            Files.deleteIfExists(requestFile);
            debugLog("ASK_FILE_DELETE", "Deleted AskUserQuestion request file: " + fileName);

        } catch (NoSuchFileException e) {
            debugLog("ASK_FILE_MISSING", "AskUserQuestion file missing while reading, likely already handled: " + fileName);
            processingRequests.remove(fileName);
            return;
        } catch (Exception e) {
            debugLog("ASK_FILE_READ_ERROR", "Error reading AskUserQuestion file: " + e.getMessage());
            LOG.error("Error occurred", e);
            processingRequests.remove(fileName);
            return;
        }

        // Parse JSON (file already deleted, so parsing failures won't cause duplicate processing)
        JsonObject request;
        try {
            request = gson.fromJson(content, JsonObject.class);
        } catch (Exception e) {
            debugLog("ASK_PARSE_ERROR", "Failed to parse AskUserQuestion JSON: " + fileName);
            processingRequests.remove(fileName);
            return;
        }

        // Validate required fields
        if (!request.has("requestId") || request.get("requestId").isJsonNull()) {
            debugLog("ASK_INVALID_FORMAT", "AskUserQuestion missing requestId field: " + fileName);
            processingRequests.remove(fileName);
            return;
        }

        if (!request.has("toolName") || request.get("toolName").isJsonNull()) {
            debugLog("ASK_INVALID_FORMAT", "AskUserQuestion missing toolName field: " + fileName);
            processingRequests.remove(fileName);
            return;
        }

        String requestId = request.get("requestId").getAsString();
        String toolName = request.get("toolName").getAsString();
        JsonObject questionsData = request;

        debugLog("ASK_REQUEST_PARSED", String.format("requestId=%s, toolName=%s", requestId, toolName));

        // Get the AskUserQuestion dialog shower (match project by cwd, supports multiple IDEA instances)
        AskUserQuestionDialogShower dialogShower = findAskUserQuestionDialogShowerByCwd(request);

        if (dialogShower != null) {
            debugLog("ASK_DIALOG_SHOWER", "Using AskUserQuestion dialog shower");

            final long dialogStartTime = System.currentTimeMillis();

            // Asynchronously invoke the frontend dialog
            debugLog("ASK_DIALOG_SHOW", "Calling dialogShower.showAskUserQuestionDialog");
            CompletableFuture<JsonObject> future = dialogShower.showAskUserQuestionDialog(requestId, questionsData);

            // Process the result asynchronously
            future.thenAccept(answers -> {
                long dialogElapsed = System.currentTimeMillis() - dialogStartTime;
                debugLog("ASK_DIALOG_RESPONSE", String.format("Got answers after %dms", dialogElapsed));
                try {
                    debugLog("ASK_WRITE_RESPONSE", String.format("Writing AskUserQuestion response for %s", requestId));
                    writeAskUserQuestionResponse(requestId, answers);

                    debugLog("ASK_DIALOG_COMPLETE", "AskUserQuestion dialog processing complete");
                } catch (Exception e) {
                    debugLog("ASK_DIALOG_ERROR", "Error processing AskUserQuestion dialog result: " + e.getMessage());
                    LOG.error("Error occurred", e);
                } finally {
                    processingRequests.remove(fileName);
                }
            }).exceptionally(ex -> {
                debugLog("ASK_DIALOG_EXCEPTION", "AskUserQuestion dialog exception: " + ex.getMessage());
                try {
                    writeAskUserQuestionResponse(requestId, new JsonObject());
                } catch (Exception e) {
                    LOG.error("Error occurred", e);
                }
                processingRequests.remove(fileName);
                return null;
            });

            // Async processing; processingRequests removal is handled in the callback
            return;
        }

        // No dialog shower available, write empty answers (deny)
        debugLog("ASK_NO_DIALOG_SHOWER", "No AskUserQuestion dialog shower available, denying");
        writeAskUserQuestionResponse(requestId, new JsonObject());
        processingRequests.remove(fileName);

        long elapsed = System.currentTimeMillis() - startTime;
        debugLog("ASK_REQUEST_COMPLETE", String.format("AskUserQuestion request %s completed in %dms", requestId, elapsed));
    }

    /**
     * Write an AskUserQuestion response file.
     * Response format: { "answers": { "question text": "answer" } }
     */
    private void writeAskUserQuestionResponse(String requestId, JsonObject answers) {
        debugLog("WRITE_ASK_RESPONSE_START", String.format("Writing AskUserQuestion response for requestId=%s", requestId));
        try {
            JsonObject response = new JsonObject();
            response.add("answers", answers);

            String fileName = String.format(ASK_USER_QUESTION_RESPONSE_FILE_PREFIX, this.sessionId, requestId);
            Path responseFile = this.permissionDir.resolve(fileName);
            String responseContent = this.gson.toJson(response);
            debugLog("ASK_RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("ASK_RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // Verify the file was written successfully
            if (Files.exists(responseFile)) {
                long fileSize = Files.size(responseFile);
                debugLog("ASK_WRITE_SUCCESS", String.format("AskUserQuestion response file written successfully, size=%d bytes", fileSize));
            } else {
                debugLog("ASK_WRITE_VERIFY_FAIL", "AskUserQuestion response file does NOT exist after write!");
            }
        } catch (IOException e) {
            debugLog("ASK_WRITE_ERROR", "Failed to write AskUserQuestion response file: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    /**
     * Handle a PlanApproval request.
     * Request file format: plan-approval-{requestId}.json
     */
    private void handlePlanApprovalRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        debugLog("PLAN_HANDLE_REQUEST", "Processing PlanApproval request file: " + fileName);

        // Check if this request is already being processed
        if (!processingRequests.add(fileName)) {
            debugLog("PLAN_SKIP_DUPLICATE", "PlanApproval request already being processed, skipping: " + fileName);
            return;
        }

        try {
            Thread.sleep(100); // Wait for file write to complete

            if (!Files.exists(requestFile)) {
                debugLog("PLAN_FILE_MISSING", "PlanApproval request file missing before read: " + fileName);
                processingRequests.remove(fileName);
                return;
            }

            String content;
            try {
                content = Files.readString(requestFile);
            } catch (NoSuchFileException e) {
                debugLog("PLAN_FILE_MISSING", "PlanApproval request file missing while reading: " + fileName);
                processingRequests.remove(fileName);
                return;
            }
            debugLog("PLAN_FILE_READ", "Read PlanApproval request content: " + content.substring(0, Math.min(200, content.length())) + "...");

            JsonObject request = gson.fromJson(content, JsonObject.class);
            String requestId = request.get("requestId").getAsString();

            debugLog("PLAN_REQUEST_PARSED", String.format("PlanApproval requestId=%s", requestId));

            // Delete the request file immediately to prevent duplicate processing
            try {
                Files.deleteIfExists(requestFile);
                debugLog("PLAN_FILE_DELETE", "Deleted PlanApproval request file: " + fileName);
            } catch (Exception e) {
                debugLog("PLAN_FILE_DELETE_ERROR", "Failed to delete PlanApproval request file: " + e.getMessage());
            }

            // Find the corresponding dialog shower (match project by cwd, supports multiple IDEA instances)
            PlanApprovalDialogShower dialogShower = findPlanApprovalDialogShowerByCwd(request);

            if (dialogShower != null) {
                debugLog("PLAN_DIALOG_SHOWER", "Using frontend dialog for PlanApproval");

                final long dialogStartTime = System.currentTimeMillis();

                // Asynchronously invoke the frontend dialog
                debugLog("PLAN_DIALOG_SHOW", "Calling dialogShower.showPlanApprovalDialog");
                CompletableFuture<JsonObject> future = dialogShower.showPlanApprovalDialog(requestId, request);

                // Process the result asynchronously
                future.thenAccept(response -> {
                    long dialogElapsed = System.currentTimeMillis() - dialogStartTime;
                    debugLog("PLAN_DIALOG_RESPONSE", String.format("Got PlanApproval response after %dms", dialogElapsed));
                    try {
                        boolean approved = response.has("approved") && response.get("approved").getAsBoolean();
                        String targetMode = response.has("targetMode") ? response.get("targetMode").getAsString() : "default";

                        debugLog("PLAN_DECISION", String.format("PlanApproval decision: approved=%s, targetMode=%s", approved, targetMode));

                        writePlanApprovalResponse(requestId, approved, targetMode);

                        debugLog("PLAN_DIALOG_COMPLETE", "PlanApproval frontend dialog processing complete");
                    } catch (Exception e) {
                        debugLog("PLAN_DIALOG_ERROR", "Error processing PlanApproval dialog result: " + e.getMessage());
                        LOG.error("Error occurred", e);
                        // Write a deny response on error
                        writePlanApprovalResponse(requestId, false, "default");
                    } finally {
                        processingRequests.remove(fileName);
                    }
                }).exceptionally(ex -> {
                    debugLog("PLAN_DIALOG_EXCEPTION", "PlanApproval frontend dialog exception: " + ex.getMessage());
                    writePlanApprovalResponse(requestId, false, "default");
                    processingRequests.remove(fileName);
                    return null;
                });

                // Async processing; processingRequests removal is handled in the callback
                return;
            }

            // No dialog shower available, write a deny response
            debugLog("PLAN_NO_DIALOG_SHOWER", "No PlanApproval dialog shower available, denying");
            writePlanApprovalResponse(requestId, false, "default");
            processingRequests.remove(fileName);

            long elapsed = System.currentTimeMillis() - startTime;
            debugLog("PLAN_REQUEST_COMPLETE", String.format("PlanApproval request %s completed in %dms", requestId, elapsed));

        } catch (Exception e) {
            debugLog("PLAN_HANDLE_ERROR", "Error handling PlanApproval request: " + e.getMessage());
            LOG.error("Error occurred", e);
            processingRequests.remove(fileName);
        }
    }

    /**
     * Write a PlanApproval response file.
     * Response format: { "approved": boolean, "targetMode": string }
     */
    private void writePlanApprovalResponse(String requestId, boolean approved, String targetMode) {
        debugLog("WRITE_PLAN_RESPONSE_START", String.format("Writing PlanApproval response for requestId=%s, approved=%s, targetMode=%s",
            requestId, approved, targetMode));
        try {
            JsonObject response = new JsonObject();
            response.addProperty("approved", approved);
            response.addProperty("targetMode", targetMode);

            String fileName = String.format(PLAN_APPROVAL_RESPONSE_FILE_PREFIX, this.sessionId, requestId);
            Path responseFile = this.permissionDir.resolve(fileName);
            String responseContent = this.gson.toJson(response);
            debugLog("PLAN_RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("PLAN_RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // Verify the file was written successfully
            if (Files.exists(responseFile)) {
                long fileSize = Files.size(responseFile);
                debugLog("PLAN_WRITE_SUCCESS", String.format("PlanApproval response file written successfully, size=%d bytes", fileSize));
            } else {
                debugLog("PLAN_WRITE_VERIFY_FAIL", "PlanApproval response file does NOT exist after write!");
            }
        } catch (IOException e) {
            debugLog("PLAN_WRITE_ERROR", "Failed to write PlanApproval response file: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    /**
     * Stop the permission service.
     */
    public void stop() {
        running = false;
        if (watchThread != null) {
            try {
                watchThread.join(1000);
            } catch (InterruptedException e) {
                LOG.error("Error occurred", e);
            }
        }
        if (watchService != null) {
            try {
                watchService.close();
            } catch (IOException e) {
                LOG.error("Error occurred", e);
            }
        }
    }

    private void notifyDecision(String toolName, JsonObject inputs, PermissionResponse response) {
        PermissionDecisionListener listener = this.decisionListener;
        if (listener == null || response == null) {
            return;
        }

        try {
            listener.onDecision(new PermissionDecision(toolName, inputs, response));
        } catch (Exception e) {
            LOG.error("Error occurred", e);
        }
    }
}
