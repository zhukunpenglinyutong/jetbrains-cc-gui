package com.github.claudecodegui.service;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.*;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ACE MCP 代理服务管理器
 * 
 * 功能：
 * 1. 为每个项目维护一个长期运行的 ACE MCP 代理进程
 * 2. 通过 HTTP API 提供 codebase-retrieval 功能
 * 3. 支持 IDEA 多开场景，每个实例独立管理
 * 4. 自动清理：IDEA 关闭时终止进程
 * 
 * 架构：
 * Java (AceMcpService) -> Node.js (ace-mcp-proxy.js) -> ACE MCP (auggie --mcp)
 */
public class AceMcpService implements Disposable {

    private static final Logger LOG = Logger.getInstance(AceMcpService.class);

    // 每个项目一个实例
    private static final Map<String, AceMcpService> instances = new ConcurrentHashMap<>();

    // 端口范围默认值：避免与常用端口冲突
    // 可通过环境变量 ACE_MCP_PORT_START / ACE_MCP_PORT_END 或配置文件 ~/.codemoss/config.json 中的 aceMcp.portStart / aceMcp.portEnd 覆盖
    private static final int DEFAULT_PORT_RANGE_START = 19800;
    private static final int DEFAULT_PORT_RANGE_END = 19899;

    // 环境变量名称
    private static final String ENV_PORT_START = "ACE_MCP_PORT_START";
    private static final String ENV_PORT_END = "ACE_MCP_PORT_END";

    // 实际使用的端口范围（延迟初始化）
    private static volatile int portRangeStart = -1;
    private static volatile int portRangeEnd = -1;
    private static final AtomicInteger portCounter = new AtomicInteger(-1);

    // 全局端口分配记录：记录每个项目已分配的端口，避免重复分配
    // key: 项目路径, value: 已分配的端口
    private static final Map<String, Integer> allocatedPorts = new ConcurrentHashMap<>();
    // 已使用的端口集合（用于快速检查端口是否已被分配）
    private static final Set<Integer> usedPorts = ConcurrentHashMap.newKeySet();
    // 端口分配锁
    private static final Object PORT_ALLOCATION_LOCK = new Object();

    // 进程启动超时
    private static final int STARTUP_TIMEOUT_SECONDS = 30;
    // 健康检查超时（毫秒）
    private static final int HEALTH_CHECK_TIMEOUT_MS = 2000;

    private final Project project;
    private final String projectPath;
    private final EnvironmentConfigurator envConfigurator;

    private Process proxyProcess;
    private int proxyPort = -1;
    private final AtomicBoolean starting = new AtomicBoolean(false);
    private final AtomicBoolean ready = new AtomicBoolean(false);
    private final AtomicBoolean disposed = new AtomicBoolean(false);

    // 用于等待代理服务就绪（使用 AtomicReference 包装 CompletableFuture，支持服务重启时重置）
    private final AtomicReference<CompletableFuture<Boolean>> readyFuture = new AtomicReference<>(new CompletableFuture<>());
    
    private AceMcpService(Project project, String projectPath) {
        this.project = project;
        this.projectPath = projectPath;
        this.envConfigurator = new EnvironmentConfigurator();
        
        // 注册到 IDEA 的 Disposable 系统
        Disposer.register(project, this);
        
        LOG.info("[AceMcpService] Created for project: " + projectPath);
    }
    
    /**
     * 获取项目对应的 ACE MCP 服务实例
     */
    public static synchronized AceMcpService getInstance(Project project, String projectPath) {
        if (projectPath == null || projectPath.isEmpty()) {
            return null;
        }
        
        return instances.computeIfAbsent(projectPath, path -> new AceMcpService(project, path));
    }
    
    /**
     * 获取代理服务端口
     * 如果服务未启动，会自动启动
     *
     * @return 端口号，如果启动失败返回 -1
     */
    public int getProxyPort() {
        if (disposed.get()) {
            LOG.warn("[AceMcpService] Service is disposed");
            return -1;
        }

        // 1. 如果服务已就绪且进程存活，直接返回端口
        if (ready.get() && isProcessAlive()) {
            return proxyPort;
        }

        // 2. 检查是否有之前分配的端口，且该端口上的服务仍在运行
        Integer previousPort = allocatedPorts.get(projectPath);
        if (previousPort != null && previousPort > 0) {
            if (checkHealthOnPort(previousPort)) {
                LOG.info("[AceMcpService] 复用已存在的代理服务，端口: " + previousPort);
                proxyPort = previousPort;
                ready.set(true);
                return proxyPort;
            } else {
                // 之前的服务已不可用，清理记录
                LOG.info("[AceMcpService] 之前的代理服务已不可用，将重新启动");
                releasePort(previousPort);
            }
        }

        // 3. 需要启动新服务
        if (starting.compareAndSet(false, true)) {
            try {
                // 重置 readyFuture，支持服务重启
                readyFuture.set(new CompletableFuture<>());
                startProxyService();
            } catch (Exception e) {
                // 启动失败可能是端口占用等预期情况，使用 warn 级别
                LOG.warn("[AceMcpService] Failed to start proxy service: " + e.getMessage());
                readyFuture.get().complete(false);
                starting.set(false);
                return -1;
            }
        }

        // 4. 等待服务就绪
        try {
            Boolean success = readyFuture.get().get(STARTUP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (success == null || !success) {
                // 启动失败可能是端口占用等预期情况，使用 warn 级别
                LOG.warn("[AceMcpService] Proxy service startup failed (may be port in use)");
                return -1;
            }
        } catch (TimeoutException e) {
            LOG.warn("[AceMcpService] Proxy service startup timeout");
            return -1;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return -1;
        } catch (ExecutionException e) {
            LOG.warn("[AceMcpService] Proxy service startup error: " + e.getMessage());
            return -1;
        }

        return ready.get() ? proxyPort : -1;
    }

    /**
     * 检查指定端口上的代理服务是否健康
     * 通过 HTTP 健康检查接口验证
     *
     * @param port 要检查的端口
     * @return true 如果服务健康，false 否则
     */
    private boolean checkHealthOnPort(int port) {
        try {
            URL url = new URL("http://127.0.0.1:" + port + "/health");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HEALTH_CHECK_TIMEOUT_MS);
            conn.setReadTimeout(HEALTH_CHECK_TIMEOUT_MS);

            int responseCode = conn.getResponseCode();
            conn.disconnect();

            if (responseCode == 200) {
                LOG.debug("[AceMcpService] 端口 " + port + " 健康检查通过");
                return true;
            }
        } catch (Exception e) {
            LOG.debug("[AceMcpService] 端口 " + port + " 健康检查失败: " + e.getMessage());
        }
        return false;
    }

    /**
     * 检查指定端口上的代理服务是否健康且 ACE MCP 已连接
     * 这个方法会解析 /health 端点的 JSON 响应，检查 connected 字段
     *
     * @param port 要检查的端口
     * @return true 如果服务健康且 ACE 已连接，false 否则
     */
    private boolean checkHealthWithAceConnection(int port) {
        try {
            URL url = new URL("http://127.0.0.1:" + port + "/health");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(HEALTH_CHECK_TIMEOUT_MS);
            conn.setReadTimeout(HEALTH_CHECK_TIMEOUT_MS);

            int responseCode = conn.getResponseCode();
            if (responseCode != 200) {
                conn.disconnect();
                return false;
            }

            // 读取响应体
            StringBuilder response = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    response.append(line);
                }
            }
            conn.disconnect();

            // 解析 JSON 响应，检查 connected 字段
            // 响应格式: {"status":"ok","connected":true,"project":"..."}
            String jsonResponse = response.toString();
            if (jsonResponse.contains("\"connected\":true") || jsonResponse.contains("\"connected\": true")) {
                LOG.info("[AceMcpService] 端口 " + port + " 健康检查通过，ACE 已连接");
                return true;
            } else {
                LOG.debug("[AceMcpService] 端口 " + port + " 服务健康但 ACE 未连接");
                return false;
            }
        } catch (Exception e) {
            LOG.debug("[AceMcpService] 端口 " + port + " 健康检查失败: " + e.getMessage());
        }
        return false;
    }

    /**
     * 释放端口记录
     *
     * @param port 要释放的端口
     */
    private void releasePort(int port) {
        synchronized (PORT_ALLOCATION_LOCK) {
            allocatedPorts.remove(projectPath);
            usedPorts.remove(port);
            LOG.info("[AceMcpService] 释放端口: " + port + " (项目: " + projectPath + ")");
        }
    }

    /**
     * 记录端口分配
     *
     * @param port 已分配的端口
     */
    private void recordPortAllocation(int port) {
        synchronized (PORT_ALLOCATION_LOCK) {
            allocatedPorts.put(projectPath, port);
            usedPorts.add(port);
            LOG.info("[AceMcpService] 记录端口分配: " + port + " -> " + projectPath);
        }
    }
    
    /**
     * 检查代理进程是否存活
     */
    public boolean isProcessAlive() {
        return proxyProcess != null && proxyProcess.isAlive();
    }
    
    /**
     * 检查服务是否就绪
     */
    public boolean isReady() {
        return ready.get() && isProcessAlive();
    }
    
    /**
     * 获取项目路径
     */
    public String getProjectPath() {
        return projectPath;
    }
    
    /**
     * 启动代理服务
     */
    private void startProxyService() throws Exception {
        LOG.info("[AceMcpService] Starting proxy service for: " + projectPath);
        
        // 分配端口（会自动初始化端口范围配置）
        proxyPort = findAvailablePort();
        if (proxyPort == -1) {
            throw new IOException("No available port in range " + portRangeStart + "-" + portRangeEnd +
                ". 可通过环境变量 " + ENV_PORT_START + "/" + ENV_PORT_END +
                " 或配置文件 ~/.codemoss/config.json 中的 aceMcp.portStart/portEnd 调整端口范围");
        }
        
        LOG.info("[AceMcpService] Allocated port: " + proxyPort);

        // 记录端口分配，防止其他项目重复使用
        recordPortAllocation(proxyPort);

        // 获取 Node.js 路径（使用单例，避免重复检测）
        String nodePath = NodeDetector.getInstance().findNodeExecutable();
        if (nodePath == null) {
            throw new IOException("Node.js not found");
        }
        
        // 获取代理脚本路径
        BridgeDirectoryResolver bridgeResolver = new BridgeDirectoryResolver();
        File bridgeDir = bridgeResolver.findSdkDir();
        if (bridgeDir == null || !bridgeDir.exists()) {
            throw new IOException("AI Bridge directory not found");
        }

        Path proxyScriptPath = Paths.get(bridgeDir.getAbsolutePath(), "services", "ace-mcp-proxy.js");

        if (!proxyScriptPath.toFile().exists()) {
            throw new IOException("ACE MCP proxy script not found: " + proxyScriptPath);
        }
        
        // 构建进程
        ProcessBuilder pb = new ProcessBuilder(
            nodePath,
            proxyScriptPath.toString(),
            "--port", String.valueOf(proxyPort),
            "--project", projectPath
        );

        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);

        // 配置环境变量
        envConfigurator.updateProcessEnvironment(pb, nodePath);

        // 启动进程
        proxyProcess = pb.start();
        LOG.info("[AceMcpService] Proxy process started, PID: " + proxyProcess.pid());

        // 启动输出读取线程
        startOutputReader();
    }

    /**
     * 读取进程输出，检测服务就绪状态
     */
    private void startOutputReader() {
        Thread readerThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(proxyProcess.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.info("[AceMcpProxy] " + line);

                    // 检测 ACE 连接建立信号（而不是仅仅 HTTP 服务器就绪）
                    // 这确保第一个请求也能使用代理模式，而不是回退到直接连接
                    if (line.contains("ACE connection established")) {
                        ready.set(true);
                        readyFuture.get().complete(true);
                        // 服务就绪后记录端口分配（确保端口确实被使用）
                        recordPortAllocation(proxyPort);
                        LOG.info("[AceMcpService] ACE MCP connection established on port " + proxyPort);
                    }

                    // 检测错误
                    if (line.contains("[ERROR]") || line.contains("EADDRINUSE")) {
                        // 端口占用是预期情况（可能已有服务在运行）
                        if (line.contains("EADDRINUSE")) {
                            LOG.warn("[AceMcpService] Port already in use, checking existing service: " + line);
                            // 检查现有服务是否健康且 ACE 已连接
                            if (checkHealthWithAceConnection(proxyPort)) {
                                LOG.info("[AceMcpService] 复用已存在的代理服务，端口: " + proxyPort);
                                ready.set(true);
                                readyFuture.get().complete(true);
                                recordPortAllocation(proxyPort);
                                return;  // 退出读取线程，因为我们复用了现有服务
                            } else {
                                LOG.warn("[AceMcpService] 现有服务不可用或 ACE 未连接，回退到直接连接模式");
                                readyFuture.get().complete(false);
                            }
                        } else {
                            LOG.warn("[AceMcpService] Proxy service error: " + line);
                            readyFuture.get().complete(false);
                        }
                    }
                }
            } catch (IOException e) {
                if (!disposed.get()) {
                    LOG.error("[AceMcpService] Error reading proxy output: " + e.getMessage());
                }
            } finally {
                if (!disposed.get()) {
                    ready.set(false);
                    starting.set(false);
                    // 确保 future 完成，避免等待线程永久阻塞
                    readyFuture.get().complete(false);
                    LOG.warn("[AceMcpService] Proxy process ended unexpectedly");
                }
            }
        }, "AceMcpProxy-Output-" + proxyPort);

        readerThread.setDaemon(true);
        readerThread.start();
    }

    /**
     * 初始化端口范围配置
     * 优先级：环境变量 > 配置文件 (~/.codemoss/config.json) > 默认值
     */
    private static synchronized void initPortRange() {
        if (portRangeStart > 0 && portRangeEnd > 0) {
            return; // 已初始化
        }

        int start = DEFAULT_PORT_RANGE_START;
        int end = DEFAULT_PORT_RANGE_END;

        // 1. 尝试从环境变量读取
        String envStart = System.getenv(ENV_PORT_START);
        String envEnd = System.getenv(ENV_PORT_END);

        if (envStart != null && !envStart.isEmpty()) {
            try {
                start = Integer.parseInt(envStart.trim());
                LOG.info("[AceMcpService] 从环境变量读取端口起始值: " + start);
            } catch (NumberFormatException e) {
                LOG.warn("[AceMcpService] 环境变量 " + ENV_PORT_START + " 格式无效: " + envStart);
            }
        }

        if (envEnd != null && !envEnd.isEmpty()) {
            try {
                end = Integer.parseInt(envEnd.trim());
                LOG.info("[AceMcpService] 从环境变量读取端口结束值: " + end);
            } catch (NumberFormatException e) {
                LOG.warn("[AceMcpService] 环境变量 " + ENV_PORT_END + " 格式无效: " + envEnd);
            }
        }

        // 2. 如果环境变量未设置，尝试从配置文件读取
        if (envStart == null && envEnd == null) {
            try {
                Path configPath = Paths.get(System.getProperty("user.home"), ".codemoss", "config.json");
                if (Files.exists(configPath)) {
                    String content = Files.readString(configPath, StandardCharsets.UTF_8);
                    JsonObject config = JsonParser.parseString(content).getAsJsonObject();

                    if (config.has("aceMcp")) {
                        JsonObject aceMcpConfig = config.getAsJsonObject("aceMcp");

                        if (aceMcpConfig.has("portStart")) {
                            start = aceMcpConfig.get("portStart").getAsInt();
                            LOG.info("[AceMcpService] 从配置文件读取端口起始值: " + start);
                        }

                        if (aceMcpConfig.has("portEnd")) {
                            end = aceMcpConfig.get("portEnd").getAsInt();
                            LOG.info("[AceMcpService] 从配置文件读取端口结束值: " + end);
                        }
                    }
                }
            } catch (Exception e) {
                LOG.warn("[AceMcpService] 读取配置文件失败，使用默认端口范围: " + e.getMessage());
            }
        }

        // 3. 验证端口范围有效性
        if (start < 1024 || start > 65535) {
            LOG.warn("[AceMcpService] 端口起始值无效 (" + start + ")，使用默认值: " + DEFAULT_PORT_RANGE_START);
            start = DEFAULT_PORT_RANGE_START;
        }

        if (end < 1024 || end > 65535) {
            LOG.warn("[AceMcpService] 端口结束值无效 (" + end + ")，使用默认值: " + DEFAULT_PORT_RANGE_END);
            end = DEFAULT_PORT_RANGE_END;
        }

        if (start >= end) {
            LOG.warn("[AceMcpService] 端口范围无效 (" + start + "-" + end + ")，使用默认范围");
            start = DEFAULT_PORT_RANGE_START;
            end = DEFAULT_PORT_RANGE_END;
        }

        portRangeStart = start;
        portRangeEnd = end;
        portCounter.set(portRangeStart);

        LOG.info("[AceMcpService] 端口范围已初始化: " + portRangeStart + "-" + portRangeEnd);
    }

    /**
     * 查找可用端口
     */
    private int findAvailablePort() {
        // 确保端口范围已初始化
        initPortRange();

        int rangeSize = portRangeEnd - portRangeStart;
        for (int i = 0; i < rangeSize; i++) {
            int port = portRangeStart + (portCounter.getAndIncrement() % rangeSize);

            // 跳过已被其他项目分配的端口
            if (usedPorts.contains(port)) {
                LOG.debug("[AceMcpService] 端口 " + port + " 已被其他项目使用，跳过");
                continue;
            }

            try (ServerSocket socket = new ServerSocket(port)) {
                socket.close();
                return port;
            } catch (IOException e) {
                // 端口被占用（可能是系统其他进程），继续尝试
            }
        }
        return -1;
    }

    /**
     * 停止代理服务
     */
    public void stop() {
        LOG.info("[AceMcpService] Stopping proxy service for: " + projectPath);

        ready.set(false);

        if (proxyProcess != null && proxyProcess.isAlive()) {
            try {
                // 先尝试优雅关闭
                proxyProcess.destroy();
                boolean terminated = proxyProcess.waitFor(3, TimeUnit.SECONDS);

                if (!terminated) {
                    LOG.warn("[AceMcpService] Force killing proxy process");
                    proxyProcess.destroyForcibly();
                    proxyProcess.waitFor(2, TimeUnit.SECONDS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                proxyProcess.destroyForcibly();
            }
        }

        proxyProcess = null;

        // 释放端口分配记录
        if (proxyPort > 0) {
            releasePort(proxyPort);
        }
        proxyPort = -1;
        starting.set(false);
    }

    @Override
    public void dispose() {
        if (disposed.compareAndSet(false, true)) {
            LOG.info("[AceMcpService] Disposing service for: " + projectPath);
            stop();
            instances.remove(projectPath);
        }
    }

    /**
     * 清理所有实例（在 IDEA 关闭时调用）
     * 使用复制列表遍历，避免并发修改异常
     */
    public static void disposeAll() {
        LOG.info("[AceMcpService] Disposing all instances, count: " + instances.size());
        // 复制实例列表，避免并发修改异常
        java.util.List<AceMcpService> servicesToStop = new java.util.ArrayList<>(instances.values());
        for (AceMcpService service : servicesToStop) {
            try {
                service.stop();
            } catch (Exception e) {
                LOG.error("[AceMcpService] Error stopping service: " + e.getMessage());
            }
        }
        instances.clear();
    }
}

