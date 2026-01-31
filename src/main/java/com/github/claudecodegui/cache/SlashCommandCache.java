package com.github.claudecodegui.cache;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.*;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.Alarm;
import com.intellij.util.messages.MessageBusConnection;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 斜杠命令智能缓存
 *
 * 功能：
 * 1. 内存缓存：避免频繁启动 Node.js 进程
 * 2. 磁盘缓存：IDEA 重启后可快速恢复（保存在 ~/.codemoss/cache/ 目录）
 * 3. 文件监听：自动检测 .claude/commands/ 目录变化
 * 4. 定期检查：10分钟保底刷新（防止监听失败）
 * 5. 通知机制：缓存更新时通知前端
 */
public class SlashCommandCache {
    private static final Logger LOG = Logger.getInstance(SlashCommandCache.class);
    private static final Gson gson = new Gson();
    private static final long DISK_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000L; // 磁盘缓存最大有效期 7 天

    private final Project project;
    private final ClaudeSDKBridge sdkBridge;
    private final String cwd;

    // 缓存数据
    private volatile List<JsonObject> cachedCommands;
    private volatile long lastLoadTime;
    private volatile long lastLoadAttemptTime;
    private volatile boolean isLoading;

    // 缓存策略配置
    private static final long CACHE_TTL = 10 * 60 * 1000; // 10分钟保底刷新
    private static final long MIN_REFRESH_INTERVAL = 500; // 最小刷新间隔 500ms（加快响应）
    private static final long LOAD_TIMEOUT_SECONDS = 25; // SDK 调用超时时间 25秒（与 ClaudeSDKBridge 中的 20s 轮询配合）

    // 监听器
    private MessageBusConnection messageBusConnection;
    private Timer periodicCheckTimer;
    private final List<Consumer<List<JsonObject>>> updateListeners;
    private final Alarm refreshAlarm;

    public SlashCommandCache(Project project, ClaudeSDKBridge sdkBridge, String cwd) {
        this.project = project;
        this.sdkBridge = sdkBridge;
        this.cwd = cwd;
        this.cachedCommands = new ArrayList<>();
        this.lastLoadTime = 0;
        this.lastLoadAttemptTime = 0;
        this.isLoading = false;
        this.updateListeners = new CopyOnWriteArrayList<>();
        this.refreshAlarm = new Alarm(Alarm.ThreadToUse.POOLED_THREAD, project);
    }

    /**
     * 初始化缓存系统
     */
    public void init() {
        LOG.info("Initializing cache system");

        // 1. 先尝试从磁盘加载缓存（秒级恢复）
        boolean hasDiskCache = loadCacheFromDisk();
        if (hasDiskCache) {
            LOG.info("Loaded " + cachedCommands.size() + " commands from disk cache");
            // 立即通知监听器使用磁盘缓存
            notifyListeners();
        }

        // 2. 设置文件监听
        setupFileWatcher();

        // 3. 后台静默刷新（获取最新数据）
        // 即使有磁盘缓存，也要后台更新以确保数据最新
        loadCommands();

        // 4. 定期检查已禁用（避免频繁的远程 API 计费）
        // schedulePeriodicCheck();
    }

    /**
     * 获取缓存的命令列表
     */
    public List<JsonObject> getCommands() {
        return new ArrayList<>(cachedCommands);
    }

    /**
     * 检查缓存是否为空
     */
    public boolean isEmpty() {
        return cachedCommands.isEmpty();
    }

    /**
     * 检查是否正在加载
     */
    public boolean isLoading() {
        return isLoading;
    }

    /**
     * 添加更新监听器
     */
    public void addUpdateListener(Consumer<List<JsonObject>> listener) {
        updateListeners.add(listener);
    }

    /**
     * 加载命令列表
     */
    private void loadCommands() {
        long now = System.currentTimeMillis();

        // 防抖：如果距离上次加载尝试时间太短，跳过
        if (now - lastLoadAttemptTime < MIN_REFRESH_INTERVAL) {
            LOG.debug("Skipping load (too soon after last attempt)");
            return;
        }

        // 如果正在加载,跳过
        if (isLoading) {
            LOG.debug("Already loading, skipping");
            return;
        }

        lastLoadAttemptTime = now;
        isLoading = true;
        long startTime = System.currentTimeMillis();
        LOG.info("Loading slash commands from SDK");

        // 添加超时机制：30秒超时
        sdkBridge.getSlashCommands(cwd)
                .orTimeout(LOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .thenAccept(commands -> {
                    long duration = System.currentTimeMillis() - startTime;
                    if (commands != null && !commands.isEmpty()) {
                        cachedCommands = new ArrayList<>(commands);
                        lastLoadTime = System.currentTimeMillis();
                        LOG.info("Loaded " + commands.size() + " commands in " + duration + "ms");

                        // 保存到磁盘缓存
                        saveCacheToDisk();

                        // 通知所有监听器
                        notifyListeners();
                    } else {
                        LOG.info("No commands received (took " + duration + "ms)");
                    }
                    isLoading = false;
                }).exceptionally(ex -> {
                    long duration = System.currentTimeMillis() - startTime;
                    isLoading = false;

                    if (ex.getCause() instanceof java.util.concurrent.TimeoutException) {
                        LOG.warn("Load commands timeout after " + LOAD_TIMEOUT_SECONDS + " seconds (took " + duration + "ms)");
                    } else {
                        LOG.warn("Failed to load commands (took " + duration + "ms): " + ex.getMessage(), ex);
                    }
                    return null;
                });
    }

    /**
     * 设置文件监听器
     */
    private void setupFileWatcher() {
        // 使用消息总线订阅文件变化事件（推荐的新方式）
        messageBusConnection = ApplicationManager.getApplication().getMessageBus().connect();

        messageBusConnection.subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            @Override
            public void after(List<? extends VFileEvent> events) {
                for (VFileEvent event : events) {
                    VirtualFile file = event.getFile();
                    if (file != null && isCommandFile(file)) {
                        LOG.info("Command file changed: " + file.getPath());
                        refreshAlarm.cancelAllRequests();
                        refreshAlarm.addRequest(SlashCommandCache.this::loadCommands, 500);
                        break; // 只需要触发一次刷新
                    }
                }
            }
        });

        LOG.info("File watcher setup complete (using MessageBus)");
    }

    /**
     * 检查是否是命令文件
     */
    private boolean isCommandFile(VirtualFile file) {
        if (file == null) return false;

        String path = file.getPath();
        // 检查是否在 .claude/commands/ 目录下
        return path.contains(".claude/commands/") || path.contains(".claude\\commands\\");
    }

    /**
     * 设置定期检查
     */
    private void schedulePeriodicCheck() {
        periodicCheckTimer = new Timer("SlashCommandCache-PeriodicCheck", true);
        periodicCheckTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                long now = System.currentTimeMillis();
                if (now - lastLoadTime > CACHE_TTL) {
                    LOG.info("Periodic check: refreshing cache");
                    loadCommands();
                }
            }
        }, CACHE_TTL, CACHE_TTL);
        LOG.info("Periodic check scheduled (every 10 minutes)");
    }

    /**
     * 获取磁盘缓存文件路径
     * 缓存保存在 ~/.codemoss/cache/slash-commands/ 目录下
     * 使用项目路径的 hash 作为文件名，避免不同项目缓存冲突
     */
    private Path getCacheFilePath() {
        String basePath = project.getBasePath();
        if (basePath == null) {
            return null;
        }

        // 使用项目目录名 + 路径哈希生成唯一的缓存文件名，降低哈希冲突风险
        String projectHash = Integer.toHexString(basePath.hashCode());
        int lastSep = Math.max(basePath.lastIndexOf('/'), basePath.lastIndexOf('\\'));
        String dirName = lastSep >= 0 ? basePath.substring(lastSep + 1) : basePath;
        String safeDirName = dirName.replaceAll("[^a-zA-Z0-9._-]", "_");
        String cacheFileName = "commands_" + safeDirName + "_" + projectHash + ".json";

        // 缓存目录：~/.codemoss/cache/slash-commands/
        String userHome = System.getProperty("user.home");
        return Path.of(userHome, ".codemoss", "cache", "slash-commands", cacheFileName);
    }

    /**
     * 从磁盘加载缓存
     * @return true 如果成功加载了缓存
     */
    private boolean loadCacheFromDisk() {
        Path cacheFile = getCacheFilePath();
        if (cacheFile == null) {
            LOG.debug("Cannot get cache file path (project basePath is null)");
            return false;
        }

        if (!Files.exists(cacheFile)) {
            LOG.debug("Disk cache file not found: " + cacheFile);
            return false;
        }

        try {
            // 检查缓存文件是否过期
            long fileAge = System.currentTimeMillis() - Files.getLastModifiedTime(cacheFile).toMillis();
            if (fileAge > DISK_CACHE_MAX_AGE) {
                LOG.info("Disk cache too old (" + (fileAge / 1000 / 3600) + "h), skipping: " + cacheFile);
                return false;
            }

            String json = Files.readString(cacheFile, StandardCharsets.UTF_8);
            Type listType = new TypeToken<List<JsonObject>>(){}.getType();
            List<JsonObject> commands = gson.fromJson(json, listType);

            if (commands != null && !commands.isEmpty()) {
                cachedCommands = new ArrayList<>(commands);
                lastLoadTime = System.currentTimeMillis();
                LOG.info("Loaded " + commands.size() + " commands from disk cache: " + cacheFile);
                return true;
            }
        } catch (IOException e) {
            LOG.warn("Failed to read disk cache: " + e.getMessage());
        } catch (Exception e) {
            LOG.warn("Failed to parse disk cache: " + e.getMessage());
        }

        return false;
    }

    /**
     * 保存缓存到磁盘
     */
    private void saveCacheToDisk() {
        Path cacheFile = getCacheFilePath();
        if (cacheFile == null) {
            LOG.debug("Cannot save cache (project basePath is null)");
            return;
        }

        try {
            // 确保缓存目录存在
            Path cacheDir = cacheFile.getParent();
            if (!Files.exists(cacheDir)) {
                Files.createDirectories(cacheDir);
            }

            String json = gson.toJson(cachedCommands);
            Files.writeString(cacheFile, json, StandardCharsets.UTF_8);
            LOG.info("Saved " + cachedCommands.size() + " commands to disk cache: " + cacheFile);
        } catch (IOException e) {
            LOG.warn("Failed to save disk cache: " + e.getMessage());
        }
    }

    /**
     * 通知所有监听器
     */
    private void notifyListeners() {
        List<JsonObject> commands = getCommands();
        for (Consumer<List<JsonObject>> listener : updateListeners) {
            try {
                listener.accept(commands);
            } catch (Exception e) {
                LOG.warn("Error notifying listener: " + e.getMessage(), e);
            }
        }
    }

    /**
     * 清理资源
     */
    public void dispose() {
        LOG.info("Disposing cache system");

        // 断开消息总线连接
        if (messageBusConnection != null) {
            messageBusConnection.disconnect();
        }

        // 定期检查已禁用，无需取消
        // if (periodicCheckTimer != null) {
        //     periodicCheckTimer.cancel();
        // }

        refreshAlarm.cancelAllRequests();
        refreshAlarm.dispose();

        // 清空监听器列表
        updateListeners.clear();
    }
}
