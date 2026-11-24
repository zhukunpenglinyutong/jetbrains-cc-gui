package com.github.claudecodegui.watcher;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileContentChangeEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;

import java.util.List;

public class McpConfigFileWatcher implements BulkFileListener {
    private static final Logger LOG = Logger.getInstance(McpConfigFileWatcher.class);

    private final Project project;
    private final McpConfigReloader reloader;
    private MessageBusConnection connection;

    public McpConfigFileWatcher(Project project, McpConfigReloader reloader) {
        this.project = project;
        this.reloader = reloader;
    }

    @Override
    public void after(@NotNull List<? extends VFileEvent> events) {
        for (VFileEvent event : events) {
            if (event instanceof VFileContentChangeEvent
                    || event instanceof VFileCreateEvent
                    || event instanceof VFileDeleteEvent) {
                VirtualFile file = event.getFile();
                String filePath = file != null ? file.getPath() : "";
                LOG.info("[McpConfigFileWatcher] VFS event: " + event.getClass().getSimpleName() + " path=" + filePath);

                if (file != null && isMcpConfigFile(file)) {
                    LOG.info("[McpConfigFileWatcher] Detected change in MCP config: " + filePath);
                    try {
                        reloader.reloadMcpServers();
                    } catch (Exception e) {
                        LOG.warn("[McpConfigFileWatcher] Failed to reload MCP servers: " + e.getMessage());
                    }
                }
            }
        }
    }

    private boolean isMcpConfigFile(VirtualFile file) {
        if (file == null) {
            return false;
        }
        String name = file.getName();
        return name.equals(".mcp.json") || name.equals("mcp.json");
    }

    public void startWatching() {
        if (connection != null) {
            LOG.warn("[McpConfigFileWatcher] Already watching, skipping");
            return;
        }

        connection = project.getMessageBus().connect();
        connection.subscribe(VirtualFileManager.VFS_CHANGES, this);
        LOG.info("[McpConfigFileWatcher] Started watching for .mcp.json / mcp.json changes");
    }

    public void stopWatching() {
        if (connection != null) {
            connection.disconnect();
            connection = null;
            LOG.info("[McpConfigFileWatcher] Stopped watching MCP config files");
        }
    }

    @FunctionalInterface
    public interface McpConfigReloader {
        void reloadMcpServers();
    }
}
