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
 * 权限服务 - 处理Node.js的权限请求
 */
public class PermissionService {

    private static final Logger LOG = Logger.getInstance(PermissionService.class);

    private static PermissionService instance;
    private final Project project;
    private final Path permissionDir;
    private final Gson gson = new Gson();
    private WatchService watchService;
    private Thread watchThread;
    private boolean running = false;

    // 记忆用户选择（工具+参数级别）
    private final Map<String, Integer> permissionMemory = new ConcurrentHashMap<>();
    // 工具级别权限记忆（仅工具名 -> 是否总是允许）
    private final Map<String, Boolean> toolOnlyPermissionMemory = new ConcurrentHashMap<>();
    private volatile PermissionDecisionListener decisionListener;

    // 多项目支持：按项目注册的权限对话框显示器
    private final Map<Project, PermissionDialogShower> dialogShowers = new ConcurrentHashMap<>();

    // 多项目支持：按项目注册的 AskUserQuestion 对话框显示器
    private final Map<Project, AskUserQuestionDialogShower> askUserQuestionDialogShowers = new ConcurrentHashMap<>();

    // 调试日志辅助方法
    private void debugLog(String tag, String message) {
        LOG.debug(String.format("[%s] %s", tag, message));
    }

    private void debugLog(String tag, String message, Object data) {
        LOG.debug(String.format("[%s] %s | Data: %s", tag, message, this.gson.toJson(data)));
    }

    public enum PermissionResponse {
        ALLOW(1, "允许"),
        ALLOW_ALWAYS(2, "允许且不再询问"),
        DENY(3, "拒绝");

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
     * 权限对话框显示器接口 - 用于显示前端弹窗
     */
    public interface PermissionDialogShower {
        /**
         * 显示权限对话框并返回用户决策
         * @param toolName 工具名称
         * @param inputs 输入参数
         * @return CompletableFuture<Integer> 返回 PermissionResponse 的值
         */
        CompletableFuture<Integer> showPermissionDialog(String toolName, JsonObject inputs);
    }

    /**
     * AskUserQuestion 对话框显示器接口 - 用于显示问题对话框
     */
    public interface AskUserQuestionDialogShower {
        /**
         * 显示 AskUserQuestion 对话框并返回用户答案
         * @param requestId 请求ID
         * @param questions 问题列表（JSON 数组）
         * @return CompletableFuture<JsonObject> 返回用户答案（格式：{ "问题文本": "答案" }）
         */
        CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questions);
    }

    private PermissionService(Project project) {
        this.project = project;
        // 使用临时目录进行通信
        this.permissionDir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        debugLog("INIT", "Permission dir: " + permissionDir);
        debugLog("INIT", "java.io.tmpdir: " + System.getProperty("java.io.tmpdir"));
        try {
            Files.createDirectories(permissionDir);
            debugLog("INIT", "Permission directory created/verified: " + permissionDir);
        } catch (IOException e) {
            debugLog("INIT_ERROR", "Failed to create permission dir: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    public static synchronized PermissionService getInstance(Project project) {
        if (instance == null) {
            instance = new PermissionService(project);
        }
        return instance;
    }

    public void setDecisionListener(PermissionDecisionListener listener) {
        this.decisionListener = listener;
        debugLog("CONFIG", "Decision listener set: " + (listener != null));
    }

    /**
     * 注册权限对话框显示器（用于显示前端弹窗）
     * 支持多项目：每个项目注册自己的显示器
     *
     * @param project 项目
     * @param shower 权限对话框显示器
     */
    public void registerDialogShower(Project project, PermissionDialogShower shower) {
        if (project != null && shower != null) {
            dialogShowers.put(project, shower);
            debugLog("CONFIG", "Dialog shower registered for project: " + project.getName() +
                ", total registered: " + dialogShowers.size());
        }
    }

    /**
     * 注销权限对话框显示器
     * 在项目关闭时调用，防止内存泄漏
     *
     * @param project 项目
     */
    public void unregisterDialogShower(Project project) {
        if (project != null) {
            PermissionDialogShower removed = dialogShowers.remove(project);
            debugLog("CONFIG", "Dialog shower unregistered for project: " + project.getName() +
                ", was registered: " + (removed != null) + ", remaining: " + dialogShowers.size());
        }
    }

    /**
     * 注册 AskUserQuestion 对话框显示器
     * 支持多项目：每个项目注册自己的显示器
     *
     * @param project 项目
     * @param shower AskUserQuestion 对话框显示器
     */
    public void registerAskUserQuestionDialogShower(Project project, AskUserQuestionDialogShower shower) {
        if (project != null && shower != null) {
            askUserQuestionDialogShowers.put(project, shower);
            debugLog("CONFIG", "AskUserQuestion dialog shower registered for project: " + project.getName() +
                ", total registered: " + askUserQuestionDialogShowers.size());
        }
    }

    /**
     * 注销 AskUserQuestion 对话框显示器
     * 在项目关闭时调用，防止内存泄漏
     *
     * @param project 项目
     */
    public void unregisterAskUserQuestionDialogShower(Project project) {
        if (project != null) {
            AskUserQuestionDialogShower removed = askUserQuestionDialogShowers.remove(project);
            debugLog("CONFIG", "AskUserQuestion dialog shower unregistered for project: " + project.getName() +
                ", was registered: " + (removed != null) + ", remaining: " + askUserQuestionDialogShowers.size());
        }
    }

    /**
     * 设置权限对话框显示器（用于显示前端弹窗）
     * @deprecated 使用 {@link #registerDialogShower(Project, PermissionDialogShower)} 代替
     */
    @Deprecated
    public void setDialogShower(PermissionDialogShower shower) {
        // 兼容旧代码：使用默认项目注册
        if (shower != null && this.project != null) {
            dialogShowers.put(this.project, shower);
        }
        debugLog("CONFIG", "Dialog shower set (legacy): " + (shower != null));
    }

    /**
     * 根据文件路径匹配项目
     * 从 inputs 中提取文件路径，然后找到对应的项目
     *
     * @param inputs 权限请求的输入参数
     * @return 匹配的项目对应的 DialogShower，如果匹配不到则返回第一个注册的
     */
    private PermissionDialogShower findDialogShowerByInputs(JsonObject inputs) {
        if (dialogShowers.isEmpty()) {
            debugLog("MATCH_PROJECT", "No dialog showers registered");
            return null;
        }

        // 只有一个项目时，直接返回
        if (dialogShowers.size() == 1) {
            Map.Entry<Project, PermissionDialogShower> entry = dialogShowers.entrySet().iterator().next();
            debugLog("MATCH_PROJECT", "Single project registered: " + entry.getKey().getName());
            return entry.getValue();
        }

        // 从 inputs 中提取文件路径
        String filePath = extractFilePathFromInputs(inputs);
        if (filePath == null || filePath.isEmpty()) {
            debugLog("MATCH_PROJECT", "No file path found in inputs, using first registered project");
            return dialogShowers.values().iterator().next();
        }

        // 规范化文件路径（统一使用 Unix 风格的 / 分隔符）
        String normalizedFilePath = normalizePath(filePath);
        debugLog("MATCH_PROJECT", "Extracted file path: " + filePath +
            (filePath.equals(normalizedFilePath) ? "" : " (normalized: " + normalizedFilePath + ")"));

        // 遍历所有项目，找到路径匹配的项目（选择最长匹配）
        Project bestMatch = null;
        int longestMatchLength = 0;

        for (Map.Entry<Project, PermissionDialogShower> entry : dialogShowers.entrySet()) {
            Project project = entry.getKey();
            String projectPath = project.getBasePath();

            if (projectPath != null) {
                // 规范化项目路径
                String normalizedProjectPath = normalizePath(projectPath);

                // 使用新的路径匹配方法（检查路径分隔符）
                if (isFileInProject(normalizedFilePath, normalizedProjectPath)) {
                    if (normalizedProjectPath.length() > longestMatchLength) {
                        longestMatchLength = normalizedProjectPath.length();
                        bestMatch = project;
                        debugLog("MATCH_PROJECT", "Found potential match: " + project.getName() +
                            " (path: " + projectPath + ", length: " + normalizedProjectPath.length() + ")");
                    }
                }
            }
        }

        if (bestMatch != null) {
            debugLog("MATCH_PROJECT", "Matched project: " + bestMatch.getName() + " (path: " + bestMatch.getBasePath() + ")");
            return dialogShowers.get(bestMatch);
        }

        // 匹配失败，使用第一个注册的项目
        Map.Entry<Project, PermissionDialogShower> firstEntry = dialogShowers.entrySet().iterator().next();
        debugLog("MATCH_PROJECT", "No matching project found, using first: " + firstEntry.getKey().getName());
        return firstEntry.getValue();
    }

    /**
     * 从 inputs 中提取文件路径
     * 支持多种字段：file_path、path、command 中的路径等
     */
    private String extractFilePathFromInputs(JsonObject inputs) {
        if (inputs == null) {
            return null;
        }

        // 优先检查 file_path 字段（最常见）
        if (inputs.has("file_path") && !inputs.get("file_path").isJsonNull()) {
            return inputs.get("file_path").getAsString();
        }

        // 检查 path 字段
        if (inputs.has("path") && !inputs.get("path").isJsonNull()) {
            return inputs.get("path").getAsString();
        }

        // 检查 notebook_path 字段（Jupyter notebooks）
        if (inputs.has("notebook_path") && !inputs.get("notebook_path").isJsonNull()) {
            return inputs.get("notebook_path").getAsString();
        }

        // 从 command 字段中提取路径（尝试找到绝对路径）
        if (inputs.has("command") && !inputs.get("command").isJsonNull()) {
            String command = inputs.get("command").getAsString();
            // 简单的路径提取：查找以 / 开头的路径（Unix）或包含 :\ 的路径（Windows）
            String[] parts = command.split("\\s+");
            for (String part : parts) {
                if (part.startsWith("/") || (part.length() > 2 && part.charAt(1) == ':')) {
                    // 去除可能的引号
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
     * 规范化文件路径
     * 统一路径分隔符为 Unix 风格 (/)，确保跨平台兼容性
     *
     * @param path 原始路径
     * @return 规范化后的路径，如果输入为 null 则返回 null
     */
    private String normalizePath(String path) {
        if (path == null) {
            return null;
        }
        // 将 Windows 风格的反斜杠替换为正斜杠
        return path.replace('\\', '/');
    }

    /**
     * 检查文件路径是否属于项目路径
     * 确保匹配的是完整的路径前缀，而不是字符串前缀
     *
     * 例如：
     * - /home/user/my-app/file.txt 属于 /home/user/my-app ✓
     * - /home/user/my-app-v2/file.txt 不属于 /home/user/my-app ✓
     *
     * @param filePath 文件路径（已规范化）
     * @param projectPath 项目路径（已规范化）
     * @return true 如果文件属于该项目
     */
    private boolean isFileInProject(String filePath, String projectPath) {
        if (filePath == null || projectPath == null) {
            return false;
        }

        // 完全相等的情况
        if (filePath.equals(projectPath)) {
            return true;
        }

        // 确保 projectPath 以分隔符结尾，避免前缀匹配错误
        // 例如：/home/user/my-app/ 而不是 /home/user/my-app
        String normalizedProjectPath = projectPath.endsWith("/")
            ? projectPath
            : projectPath + "/";

        // 检查文件路径是否以 "项目路径/" 开头
        return filePath.startsWith(normalizedProjectPath);
    }

    /**
     * 启动权限服务
     */
    public void start() {
        if (running) {
            debugLog("START", "Already running, skipping start");
            return;
        }

        // 清理旧的响应文件,避免误处理
        cleanupOldResponseFiles();

        running = true;

        watchThread = new Thread(this::watchLoop, "PermissionWatcher");
        watchThread.setDaemon(true);
        watchThread.start();

        debugLog("START", "Started polling on: " + permissionDir);
    }

    /**
     * 清理旧的响应文件和请求文件
     */
    private void cleanupOldResponseFiles() {
        try {
            File dir = permissionDir.toFile();
            if (!dir.exists()) {
                return;
            }

            // 清理普通权限响应文件
            File[] responseFiles = dir.listFiles((d, name) -> name.startsWith("response-") && name.endsWith(".json"));
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

            // 清理普通权限请求文件（可能是未完成的请求）
            File[] requestFiles = dir.listFiles((d, name) -> name.startsWith("request-") && name.endsWith(".json"));
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

            // 清理所有 AskUserQuestion 相关文件（请求和响应）
            File[] askFiles = dir.listFiles((d, name) ->
                name.startsWith("ask-user-question-") && name.endsWith(".json"));
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

            debugLog("CLEANUP", "All old permission files cleanup complete");
        } catch (Exception e) {
            debugLog("CLEANUP_ERROR", "Error during cleanup: " + e.getMessage());
        }
    }

    /**
     * 监控文件变化
     * 改为轮询模式，以提高在 macOS /tmp 目录下的可靠性
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

                // 监控普通权限请求文件
                File[] requestFiles = dir.listFiles((d, name) -> name.startsWith("request-") && name.endsWith(".json"));

                // 监控 AskUserQuestion 请求文件 (排除响应文件)
                File[] askUserQuestionFiles = dir.listFiles((d, name) ->
                    name.startsWith("ask-user-question-") &&
                    !name.startsWith("ask-user-question-response-") &&
                    name.endsWith(".json"));

                // 每20次轮询（约10秒）输出一次状态
                // 降低日志频率：每100次轮询（约50秒）记录一次状态
                if (pollCount % 100 == 0) {
                    int requestCount = requestFiles != null ? requestFiles.length : 0;
                    int askQuestionCount = askUserQuestionFiles != null ? askUserQuestionFiles.length : 0;
                    debugLog("POLL_STATUS", String.format("Poll #%d, found %d request files, %d ask-user-question files",
                        pollCount, requestCount, askQuestionCount));
                }

                // 处理普通权限请求
                if (requestFiles != null && requestFiles.length > 0) {
                    for (File file : requestFiles) {
                        // 简单防重：检查文件是否还存在（可能被其他线程处理了）
                        if (file.exists()) {
                            debugLog("REQUEST_FOUND", "Found request file: " + file.getName());
                            handlePermissionRequest(file.toPath());
                        }
                    }
                }

                // 处理 AskUserQuestion 请求
                if (askUserQuestionFiles != null && askUserQuestionFiles.length > 0) {
                    for (File file : askUserQuestionFiles) {
                        if (file.exists()) {
                            debugLog("ASK_USER_QUESTION_FOUND", "Found AskUserQuestion file: " + file.getName());
                            handleAskUserQuestionRequest(file.toPath());
                        }
                    }
                }

                // 轮询间隔 500ms
                Thread.sleep(500);
            } catch (Exception e) {
                debugLog("POLL_ERROR", "Error in poll loop: " + e.getMessage());
                LOG.error("Error occurred", e);
                try {
                    Thread.sleep(1000); // 出错后稍作等待
                } catch (InterruptedException ex) {
                    break;
                }
            }
        }
        debugLog("WATCH_LOOP", "Polling loop ended");
    }

    // 记录正在处理的请求文件，避免重复处理
    private final Set<String> processingRequests = ConcurrentHashMap.newKeySet();

    /**
     * 处理权限请求
     */
    private void handlePermissionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        debugLog("HANDLE_REQUEST", "Processing request file: " + fileName);

        // 检查是否正在处理该请求
        if (!processingRequests.add(fileName)) {
            debugLog("SKIP_DUPLICATE", "Request already being processed, skipping: " + fileName);
            return;
        }

        try {
            Thread.sleep(100); // 等待文件写入完成

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

            // 首先检查工具级别的权限记忆（总是允许）
            if (toolOnlyPermissionMemory.containsKey(toolName)) {
                boolean allow = toolOnlyPermissionMemory.get(toolName);
                debugLog("MEMORY_HIT", "Using tool-level memory for " + toolName + " -> " + (allow ? "ALLOW" : "DENY"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, allow ? PermissionResponse.ALLOW_ALWAYS : PermissionResponse.DENY);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // 生成内存键（工具+参数）
            String memoryKey = toolName + ":" + inputs.toString().hashCode();
            debugLog("MEMORY_KEY", "Generated memory key: " + memoryKey);

            // 检查是否有记忆的选择（工具+参数级别）
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

            // 根据文件路径匹配项目，找到对应的前端弹窗显示器
            PermissionDialogShower matchedDialogShower = findDialogShowerByInputs(inputs);

            // 如果有前端弹窗显示器，使用异步方式
            if (matchedDialogShower != null) {
                debugLog("DIALOG_SHOWER", "Using frontend dialog for: " + toolName);

                // 立即删除请求文件，避免重复处理
                try {
                    Files.deleteIfExists(requestFile);
                    debugLog("FILE_DELETE", "Deleted request file: " + fileName);
                } catch (Exception e) {
                    debugLog("FILE_DELETE_ERROR", "Failed to delete request file: " + e.getMessage());
                }

                final String memKey = memoryKey;
                final String tool = toolName;
                final long dialogStartTime = System.currentTimeMillis();

                // 异步调用前端弹窗
                debugLog("DIALOG_SHOW", "Calling dialogShower.showPermissionDialog for: " + toolName);
                CompletableFuture<Integer> future = matchedDialogShower.showPermissionDialog(toolName, inputs);

                // 异步处理结果
                future.thenAccept(response -> {
                    long dialogElapsed = System.currentTimeMillis() - dialogStartTime;
                    debugLog("DIALOG_RESPONSE", String.format("Got response %d after %dms for %s", response, dialogElapsed, tool));
                    try {
                        PermissionResponse decision = PermissionResponse.fromValue(response);
                        if (decision == null) {
                            debugLog("RESPONSE_NULL", "Response value " + response + " mapped to null, defaulting to DENY");
                            decision = PermissionResponse.DENY;
                        }

                        boolean allow;
                        switch (decision) {
                            case ALLOW:
                                allow = true;
                                debugLog("DECISION", "ALLOW (single) for " + tool);
                                break;
                            case ALLOW_ALWAYS:
                                allow = true;
                                // 保存到工具级别权限记忆（按工具类型，不是按参数）
                                toolOnlyPermissionMemory.put(tool, true);
                                debugLog("DECISION", "ALLOW_ALWAYS for " + tool + ", saved to memory");
                                break;
                            case DENY:
                            default:
                                allow = false;
                                debugLog("DECISION", "DENY for " + tool);
                                break;
                        }

                        notifyDecision(toolName, inputs, decision);
                        debugLog("WRITE_RESPONSE", String.format("Writing response for %s: allow=%s", requestId, allow));
                        writeResponse(requestId, allow);

                        debugLog("DIALOG_COMPLETE", "Frontend dialog processing complete: allow=" + allow);
                    } catch (Exception e) {
                        debugLog("DIALOG_ERROR", "Error processing dialog result: " + e.getMessage());
                        LOG.error("Error occurred", e);
                    } finally {
                        processingRequests.remove(fileName);
                    }
                }).exceptionally(ex -> {
                    debugLog("DIALOG_EXCEPTION", "Frontend dialog exception: " + ex.getMessage());
                    try {
                        writeResponse(requestId, false);
                    } catch (Exception e) {
                        LOG.error("Error occurred", e);
                    }
                    notifyDecision(toolName, inputs, PermissionResponse.DENY);
                    processingRequests.remove(fileName);
                    return null;
                });

                // 异步处理，直接返回，不阻塞
                return;
            }

            // 降级方案：使用系统弹窗（同步阻塞）
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

            // 写入响应
            debugLog("WRITE_RESPONSE", String.format("Writing response for %s: allow=%s", requestId, allow));
            writeResponse(requestId, allow);

            // 删除请求文件
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
     * 显示系统权限对话框（JOptionPane）- 降级方案
     */
    private int showSystemPermissionDialog(String toolName, JsonObject inputs) {
        // 构建消息内容
        StringBuilder message = new StringBuilder();
        message.append("Claude 请求执行以下操作：\n\n");
        message.append("工具：").append(toolName).append("\n");

        // 显示重要参数
        if (inputs.has("file_path")) {
            message.append("文件：").append(inputs.get("file_path").getAsString()).append("\n");
        }
        if (inputs.has("command")) {
            message.append("命令：").append(inputs.get("command").getAsString()).append("\n");
        }

        message.append("\n是否允许执行？");

        // 创建选项
        Object[] options = {
            "允许",
            "拒绝"
        };

        // 显示对话框
        int result = JOptionPane.showOptionDialog(
            null,
            message.toString(),
            "权限请求 - " + toolName,
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
     * 写入响应文件
     */
    private void writeResponse(String requestId, boolean allow) {
        debugLog("WRITE_RESPONSE_START", String.format("Writing response for requestId=%s, allow=%s", requestId, allow));
        try {
            JsonObject response = new JsonObject();
            response.addProperty("allow", allow);

            Path responseFile = permissionDir.resolve("response-" + requestId + ".json");
            String responseContent = gson.toJson(response);
            debugLog("RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // 验证文件是否写入成功
            if (Files.exists(responseFile)) {
                long fileSize = Files.size(responseFile);
                debugLog("WRITE_SUCCESS", String.format("Response file written successfully, size=%d bytes", fileSize));
            } else {
                debugLog("WRITE_VERIFY_FAIL", "Response file does NOT exist after write!");
            }
        } catch (IOException e) {
            debugLog("WRITE_ERROR", "Failed to write response file: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    /**
     * 处理 AskUserQuestion 请求
     *
     * ⚠️ 关键修复说明：
     * 原问题：轮询间隔 500ms，但异步处理对话框需要用户交互（可能几秒到几十秒）
     * 在用户响应之前，轮询会多次检测到同一个请求文件，导致：
     * 1. 多次调用 showAskUserQuestionDialog，前端队列堆积
     * 2. 用户第一次点击后请求文件被删除，响应成功返回
     * 3. 队列中的后续请求仍然弹出对话框，但 pendingRequest 已不存在
     *
     * 修复方案：读取文件内容后立即删除请求文件，然后再进行异步处理
     */
    private void handleAskUserQuestionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        debugLog("HANDLE_ASK_USER_QUESTION", "Processing AskUserQuestion file: " + fileName);

        // 检查是否正在处理该请求（基于文件名去重）
        if (!processingRequests.add(fileName)) {
            debugLog("SKIP_DUPLICATE_ASK", "AskUserQuestion already being processed, skipping: " + fileName);
            return;
        }

        String content;
        try {
            Thread.sleep(100); // 等待文件写入完成

            if (!Files.exists(requestFile)) {
                debugLog("ASK_FILE_MISSING", "AskUserQuestion file missing before read, likely already handled: " + fileName);
                processingRequests.remove(fileName);
                return;
            }

            // 读取文件内容
            content = Files.readString(requestFile);
            debugLog("ASK_FILE_READ", "Read AskUserQuestion content: " + content.substring(0, Math.min(200, content.length())) + "...");

            // ⚠️ 关键修复: 读取后立即删除请求文件，避免轮询重复处理
            // 必须在解析和异步调用之前删除，因为轮询间隔只有 500ms
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

        // 解析 JSON（文件已删除，即使解析失败也不会重复处理）
        JsonObject request;
        try {
            request = gson.fromJson(content, JsonObject.class);
        } catch (Exception e) {
            debugLog("ASK_PARSE_ERROR", "Failed to parse AskUserQuestion JSON: " + fileName);
            processingRequests.remove(fileName);
            return;
        }

        // 验证必需字段
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

        // 获取 AskUserQuestion 对话框显示器
        AskUserQuestionDialogShower dialogShower = null;
        if (!askUserQuestionDialogShowers.isEmpty()) {
            dialogShower = askUserQuestionDialogShowers.values().iterator().next();
        }

        if (dialogShower != null) {
            debugLog("ASK_DIALOG_SHOWER", "Using AskUserQuestion dialog shower");

            final long dialogStartTime = System.currentTimeMillis();

            // 异步调用前端弹窗
            debugLog("ASK_DIALOG_SHOW", "Calling dialogShower.showAskUserQuestionDialog");
            CompletableFuture<JsonObject> future = dialogShower.showAskUserQuestionDialog(requestId, questionsData);

            // 异步处理结果
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

            // 异步处理，不在这里移除 processingRequests，由回调处理
            return;
        }

        // 没有对话框显示器，写入空答案（拒绝）
        debugLog("ASK_NO_DIALOG_SHOWER", "No AskUserQuestion dialog shower available, denying");
        writeAskUserQuestionResponse(requestId, new JsonObject());
        processingRequests.remove(fileName);

        long elapsed = System.currentTimeMillis() - startTime;
        debugLog("ASK_REQUEST_COMPLETE", String.format("AskUserQuestion request %s completed in %dms", requestId, elapsed));
    }

    /**
     * 写入 AskUserQuestion 响应文件
     * 响应格式：{ "answers": { "问题文本": "答案" } }
     */
    private void writeAskUserQuestionResponse(String requestId, JsonObject answers) {
        debugLog("WRITE_ASK_RESPONSE_START", String.format("Writing AskUserQuestion response for requestId=%s", requestId));
        try {
            JsonObject response = new JsonObject();
            response.add("answers", answers);

            Path responseFile = permissionDir.resolve("ask-user-question-response-" + requestId + ".json");
            String responseContent = gson.toJson(response);
            debugLog("ASK_RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("ASK_RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // 验证文件是否写入成功
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
     * 停止权限服务
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
