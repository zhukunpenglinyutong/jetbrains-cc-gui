package com.github.claudecodegui.cache;

import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.*;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.messages.MessageBusConnection;
import com.github.claudecodegui.ClaudeSDKBridge;

import javax.swing.*;
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
 * 2. 文件监听：自动检测 .claude/commands/ 目录变化
 * 3. 定期检查：10分钟保底刷新（防止监听失败）
 * 4. 通知机制：缓存更新时通知前端
 */
public class SlashCommandCache {
    private static final Logger LOG = Logger.getInstance(SlashCommandCache.class);
    private final Project project;
    private final ClaudeSDKBridge sdkBridge;
    private final String cwd;

    // 缓存数据
    private volatile List<JsonObject> cachedCommands;
    private volatile long lastLoadTime;
    private volatile boolean isLoading;

    // 缓存策略配置
    private static final long CACHE_TTL = 10 * 60 * 1000; // 10分钟保底刷新
    private static final long MIN_REFRESH_INTERVAL = 500; // 最小刷新间隔 500ms（加快响应）
    private static final long LOAD_TIMEOUT_SECONDS = 25; // SDK 调用超时时间 25秒（与 ClaudeSDKBridge 中的 20s 轮询配合）

    // 监听器
    private MessageBusConnection messageBusConnection;
    private Timer periodicCheckTimer;
    private final List<Consumer<List<JsonObject>>> updateListeners;

    public SlashCommandCache(Project project, ClaudeSDKBridge sdkBridge, String cwd) {
        this.project = project;
        this.sdkBridge = sdkBridge;
        this.cwd = cwd;
        this.cachedCommands = new ArrayList<>();
        this.lastLoadTime = 0;
        this.isLoading = false;
        this.updateListeners = new CopyOnWriteArrayList<>();
    }

    /**
     * 初始化缓存系统
     */
    public void init() {
        LOG.info("Initializing cache system");

        // 1. 初始加载
        loadCommands();

        // 2. 设置文件监听
        setupFileWatcher();

        // 3. 设置定期检查
        schedulePeriodicCheck();
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

        // 防抖：如果距离上次加载时间太短，跳过
        if (now - lastLoadTime < MIN_REFRESH_INTERVAL) {
            LOG.debug("Skipping load (too soon after last load)");
            return;
        }

        // 如果正在加载,跳过
        if (isLoading) {
            LOG.debug("Already loading, skipping");
            return;
        }

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
                        LOG.error("Load commands timeout after " + LOAD_TIMEOUT_SECONDS + " seconds");
                    } else {
                        LOG.error("Failed to load commands (took " + duration + "ms): " + ex.getMessage());
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
                        // 延迟刷新，避免频繁触发
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                Thread.sleep(500); // 延迟 500ms
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                            loadCommands();
                        });
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
                    ApplicationManager.getApplication().invokeLater(() -> loadCommands());
                }
            }
        }, CACHE_TTL, CACHE_TTL);
        LOG.info("Periodic check scheduled (every 10 minutes)");
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
                LOG.error("Error notifying listener: " + e.getMessage());
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

        // 取消定期检查
        if (periodicCheckTimer != null) {
            periodicCheckTimer.cancel();
        }

        // 清空监听器列表
        updateListeners.clear();
    }
}
