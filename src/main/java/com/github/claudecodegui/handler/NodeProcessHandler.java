package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.handler.core.MessageHandler;
import com.github.claudecodegui.service.NodeProcessInfo;
import com.github.claudecodegui.service.NodeProcessRegistry;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Message handler for the Node Process Management panel.
 *
 * <p>Routes three frontend events through {@link NodeProcessRegistry}:
 * <ul>
 *   <li>{@code get_node_processes} → push {@code window.updateNodeProcesses}</li>
 *   <li>{@code kill_node_process} → push {@code window.nodeProcessKillResult} + refresh list</li>
 *   <li>{@code kill_all_orphans} → push refresh list with toast count</li>
 * </ul>
 *
 * <p>All I/O work runs on {@link AppExecutorUtil#getAppExecutorService()} so the CEF IO
 * thread is never blocked.
 */
public class NodeProcessHandler implements MessageHandler {

    private static final Logger LOG = Logger.getInstance(NodeProcessHandler.class);

    private static final String[] SUPPORTED_TYPES = {
            "get_node_processes",
            "kill_node_process",
            "kill_all_orphans",
            "restart_node_daemon"
    };

    /**
     * Delay between dispatching a kill/restart command and refreshing the snapshot.
     * Gives the OS a moment to reap the terminated process so the next snapshot
     * reflects reality. Tuned via scheduled executor — no thread blocked.
     */
    private static final long KILL_REFRESH_DELAY_MS = 200L;
    private static final long RESTART_REFRESH_DELAY_MS = 500L;

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public NodeProcessHandler(HandlerContext context) {
        this.context = context;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_node_processes":
                handleGetNodeProcesses();
                return true;
            case "kill_node_process":
                handleKillNodeProcess(content);
                return true;
            case "kill_all_orphans":
                handleKillAllOrphans();
                return true;
            case "restart_node_daemon":
                handleRestartDaemon(content);
                return true;
            default:
                return false;
        }
    }

    // ============================================================================
    // Operations
    // ============================================================================

    private void handleGetNodeProcesses() {
        runAsync(() -> {
            try {
                NodeProcessRegistry registry = NodeProcessRegistry.getInstance(context.getProject());
                List<NodeProcessInfo> processes = registry.snapshot();
                String json = buildProcessListJson(processes);
                pushUpdate(json);
            } catch (Exception e) {
                LOG.warn("[NodeProcessHandler] get_node_processes failed: " + e.getMessage(), e);
                // Push empty list so the UI doesn't hang forever
                pushUpdate(buildProcessListJson(java.util.Collections.emptyList()));
            }
        });
    }

    private void handleKillNodeProcess(String rawContent) {
        runAsync(() -> {
            long pid = -1;
            String reportedId = null;
            try {
                JsonObject payload = gson.fromJson(rawContent, JsonObject.class);
                if (payload != null) {
                    if (payload.has("pid") && !payload.get("pid").isJsonNull()) {
                        pid = payload.get("pid").getAsLong();
                    }
                    if (payload.has("id") && !payload.get("id").isJsonNull()) {
                        reportedId = payload.get("id").getAsString();
                    }
                }
            } catch (Exception e) {
                LOG.warn("[NodeProcessHandler] kill_node_process bad payload: " + e.getMessage());
            }

            boolean success = false;
            String error = null;
            if (pid > 0) {
                try {
                    NodeProcessRegistry registry = NodeProcessRegistry.getInstance(context.getProject());
                    success = registry.killByPid(pid);
                } catch (Exception e) {
                    error = e.getMessage();
                }
            } else {
                error = "Invalid or missing PID";
            }

            // Report kill result to frontend
            JsonObject result = new JsonObject();
            result.addProperty("pid", pid);
            if (reportedId != null) {
                result.addProperty("id", reportedId);
            }
            result.addProperty("success", success);
            if (error != null) {
                result.addProperty("error", error);
            }
            pushKillResult(gson.toJson(result));

            // Refresh the list so the UI immediately reflects the kill. Use a
            // scheduled executor instead of Thread.sleep — the AppExecutor pool
            // is shared with the rest of the IDE and we must not block its workers.
            scheduleRefresh(KILL_REFRESH_DELAY_MS);
        });
    }

    private void handleKillAllOrphans() {
        runAsync(() -> {
            int killed = 0;
            String error = null;
            try {
                NodeProcessRegistry registry = NodeProcessRegistry.getInstance(context.getProject());
                killed = registry.killAllOrphans();
            } catch (Exception e) {
                error = e.getMessage();
                LOG.warn("[NodeProcessHandler] kill_all_orphans failed: " + e.getMessage());
            }

            JsonObject result = new JsonObject();
            result.addProperty("killed", killed);
            if (error != null) {
                result.addProperty("error", error);
            }
            pushKillResult(gson.toJson(result));

            scheduleRefresh(KILL_REFRESH_DELAY_MS);
        });
    }

    private void handleRestartDaemon(String rawContent) {
        runAsync(() -> {
            long pid = -1;
            try {
                JsonObject payload = gson.fromJson(rawContent, JsonObject.class);
                if (payload != null && payload.has("pid") && !payload.get("pid").isJsonNull()) {
                    pid = payload.get("pid").getAsLong();
                }
            } catch (Exception e) {
                LOG.warn("[NodeProcessHandler] restart_node_daemon bad payload: " + e.getMessage());
            }

            boolean success = false;
            String error = null;
            if (pid > 0) {
                try {
                    NodeProcessRegistry registry = NodeProcessRegistry.getInstance(context.getProject());
                    success = registry.restartDaemonByPid(pid);
                } catch (Exception e) {
                    error = e.getMessage();
                }
            } else {
                error = "Invalid or missing PID";
            }

            JsonObject result = new JsonObject();
            result.addProperty("pid", pid);
            result.addProperty("success", success);
            result.addProperty("restart", true);
            if (error != null) {
                result.addProperty("error", error);
            }
            pushKillResult(gson.toJson(result));

            // Restart needs slightly longer than kill — daemon shutdown drains
            // in-flight requests before the OS reaps the process.
            scheduleRefresh(RESTART_REFRESH_DELAY_MS);
        });
    }

    /**
     * Schedules a snapshot refresh after the given delay without blocking
     * any worker thread. Uses the IDE's shared scheduled executor.
     */
    private void scheduleRefresh(long delayMs) {
        AppExecutorUtil.getAppScheduledExecutorService()
                .schedule(this::handleGetNodeProcesses, delayMs, TimeUnit.MILLISECONDS);
    }

    // ============================================================================
    // Frontend push helpers
    // ============================================================================

    private void pushUpdate(String json) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript("window.updateNodeProcesses", context.escapeJs(json))
        );
    }

    private void pushKillResult(String json) {
        ApplicationManager.getApplication().invokeLater(() ->
            context.callJavaScript("window.nodeProcessKillResult", context.escapeJs(json))
        );
    }

    // ============================================================================
    // Serialization
    // ============================================================================

    private String buildProcessListJson(List<NodeProcessInfo> processes) {
        long now = System.currentTimeMillis();
        int daemonCount = 0;
        int channelCount = 0;
        int orphanCount = 0;

        JsonArray array = new JsonArray();
        for (NodeProcessInfo info : processes) {
            JsonObject o = new JsonObject();
            o.addProperty("id", info.getId());
            o.addProperty("kind", info.getKind().name());
            if (info.getProvider() != null) {
                o.addProperty("provider", info.getProvider());
            }
            o.addProperty("pid", info.getPid());
            o.addProperty("alive", info.isAlive());
            o.addProperty("startedAt", info.getStartedAtMs());
            o.addProperty("uptimeMs", info.getUptimeMs());
            if (info.getCommand() != null) {
                o.addProperty("command", info.getCommand());
            }
            if (info.getHeapUsedBytes() >= 0) {
                o.addProperty("heapUsed", info.getHeapUsedBytes());
            }
            o.addProperty("activeRequestCount", info.getActiveRequestCount());
            if (info.getChannelId() != null) {
                o.addProperty("channelId", info.getChannelId());
            }
            if (info.getSessionId() != null) {
                o.addProperty("sessionId", info.getSessionId());
            }
            if (info.getTabName() != null) {
                o.addProperty("tabName", info.getTabName());
            }
            o.addProperty("orphan", info.isOrphan());
            array.add(o);

            switch (info.getKind()) {
                case DAEMON:
                    daemonCount++;
                    break;
                case CHANNEL:
                    channelCount++;
                    break;
                case ORPHAN:
                    orphanCount++;
                    break;
            }
        }

        JsonObject totals = new JsonObject();
        totals.addProperty("daemon", daemonCount);
        totals.addProperty("channel", channelCount);
        totals.addProperty("orphan", orphanCount);
        totals.addProperty("all", processes.size());

        JsonObject root = new JsonObject();
        root.addProperty("snapshotAt", now);
        root.add("totals", totals);
        root.add("processes", array);
        return gson.toJson(root);
    }

    private void runAsync(Runnable work) {
        CompletableFuture.runAsync(work, AppExecutorUtil.getAppExecutorService())
                .exceptionally(ex -> {
                    LOG.warn("[NodeProcessHandler] Async work failed: " + ex.getMessage(), ex);
                    return null;
                });
    }
}
