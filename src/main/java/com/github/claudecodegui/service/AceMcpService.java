package com.github.claudecodegui.service;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;

import java.io.*;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

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
    
    // 端口范围：避免与常用端口冲突
    private static final int PORT_RANGE_START = 19800;
    private static final int PORT_RANGE_END = 19899;
    private static final AtomicInteger portCounter = new AtomicInteger(PORT_RANGE_START);
    
    // 进程启动超时
    private static final int STARTUP_TIMEOUT_SECONDS = 30;
    
    private final Project project;
    private final String projectPath;
    private final EnvironmentConfigurator envConfigurator;
    
    private Process proxyProcess;
    private int proxyPort = -1;
    private final AtomicBoolean starting = new AtomicBoolean(false);
    private final AtomicBoolean ready = new AtomicBoolean(false);
    private final AtomicBoolean disposed = new AtomicBoolean(false);
    
    // 用于等待代理服务就绪
    private final CountDownLatch readyLatch = new CountDownLatch(1);
    
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
        
        if (ready.get() && isProcessAlive()) {
            return proxyPort;
        }
        
        // 需要启动服务
        if (starting.compareAndSet(false, true)) {
            try {
                startProxyService();
            } catch (Exception e) {
                LOG.error("[AceMcpService] Failed to start proxy service: " + e.getMessage(), e);
                starting.set(false);
                return -1;
            }
        }
        
        // 等待服务就绪
        try {
            boolean success = readyLatch.await(STARTUP_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!success) {
                LOG.error("[AceMcpService] Proxy service startup timeout");
                return -1;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return -1;
        }
        
        return ready.get() ? proxyPort : -1;
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
        
        // 分配端口
        proxyPort = findAvailablePort();
        if (proxyPort == -1) {
            throw new IOException("No available port in range " + PORT_RANGE_START + "-" + PORT_RANGE_END);
        }
        
        LOG.info("[AceMcpService] Allocated port: " + proxyPort);
        
        // 获取 Node.js 路径
        NodeDetector nodeDetector = new NodeDetector();
        String nodePath = nodeDetector.findNodeExecutable();
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

                    // 检测服务就绪信号
                    if (line.contains("[READY]") || line.contains("Server listening on port")) {
                        ready.set(true);
                        readyLatch.countDown();
                        LOG.info("[AceMcpService] Proxy service is ready on port " + proxyPort);
                    }

                    // 检测错误
                    if (line.contains("[ERROR]") || line.contains("EADDRINUSE")) {
                        LOG.error("[AceMcpService] Proxy service error: " + line);
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
                    LOG.warn("[AceMcpService] Proxy process ended unexpectedly");
                }
            }
        }, "AceMcpProxy-Output-" + proxyPort);

        readerThread.setDaemon(true);
        readerThread.start();
    }

    /**
     * 查找可用端口
     */
    private int findAvailablePort() {
        for (int i = 0; i < (PORT_RANGE_END - PORT_RANGE_START); i++) {
            int port = PORT_RANGE_START + (portCounter.getAndIncrement() % (PORT_RANGE_END - PORT_RANGE_START));
            try (ServerSocket socket = new ServerSocket(port)) {
                socket.close();
                return port;
            } catch (IOException e) {
                // 端口被占用，继续尝试
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
     */
    public static void disposeAll() {
        LOG.info("[AceMcpService] Disposing all instances, count: " + instances.size());
        for (AceMcpService service : instances.values()) {
            try {
                service.stop();
            } catch (Exception e) {
                LOG.error("[AceMcpService] Error stopping service: " + e.getMessage());
            }
        }
        instances.clear();
    }
}

