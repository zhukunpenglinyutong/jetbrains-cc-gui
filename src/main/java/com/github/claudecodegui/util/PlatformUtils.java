package com.github.claudecodegui.util;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 平台工具类
 * 提供跨平台兼容性支持，包括平台检测、环境变量处理、进程管理等
 */
public class PlatformUtils {

    private static final Logger LOG = Logger.getInstance(PlatformUtils.class);

    // 平台类型缓存
    private static volatile PlatformType cachedPlatformType = null;
    // 插件 ID 缓存
    private static volatile String cachedPluginId = null;

    /**
     * 平台类型枚举
     */
    public enum PlatformType {
        WINDOWS,
        MACOS,
        LINUX,
        UNKNOWN
    }

    // ==================== 平台检测方法 ====================

    /**
     * 获取当前平台类型
     * @return 平台类型枚举值
     */
    public static PlatformType getPlatformType() {
        if (cachedPlatformType == null) {
            String osName = System.getProperty("os.name", "").toLowerCase();
            if (osName.contains("win")) {
                cachedPlatformType = PlatformType.WINDOWS;
            } else if (osName.contains("mac") || osName.contains("darwin")) {
                cachedPlatformType = PlatformType.MACOS;
            } else if (osName.contains("linux") || osName.contains("nix") || osName.contains("nux")) {
                cachedPlatformType = PlatformType.LINUX;
            } else {
                cachedPlatformType = PlatformType.UNKNOWN;
            }
        }
        return cachedPlatformType;
    }

    /**
     * 检查是否为 Windows 平台
     * @return true 如果是 Windows
     */
    public static boolean isWindows() {
        return getPlatformType() == PlatformType.WINDOWS;
    }

    /**
     * 检查是否为 macOS 平台
     * @return true 如果是 macOS
     */
    public static boolean isMac() {
        return getPlatformType() == PlatformType.MACOS;
    }

    /**
     * 检查是否为 Linux 平台
     * @return true 如果是 Linux
     */
    public static boolean isLinux() {
        return getPlatformType() == PlatformType.LINUX;
    }

    /**
     * 获取当前插件 ID.
     * 通过遍历所有插件并匹配类加载器来自动获取，避免硬编码。
     *
     * @return 插件 ID，如果获取失败返回兜底值
     */
    public static String getPluginId() {
        if (cachedPluginId == null) {
            synchronized (PlatformUtils.class) {
                if (cachedPluginId == null) {
                    try {
                        // 获取当前类的类加载器
                        ClassLoader classLoader = PlatformUtils.class.getClassLoader();

                        // 遍历所有插件，找到包含当前类的插件
                        for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                            if (plugin.getPluginClassLoader() == classLoader) {
                                cachedPluginId = plugin.getPluginId().getIdString();
                                LOG.info("Plugin ID detected: " + cachedPluginId);
                                return cachedPluginId;
                            }
                        }

                        // 如果没找到，使用兜底值
                        LOG.warn("Failed to detect plugin ID: no matching plugin found");
                        cachedPluginId = "com.github.idea-claude-code-gui"; // 兜底值
                    } catch (Exception e) {
                        LOG.warn("Failed to detect plugin ID: " + e.getMessage());
                        cachedPluginId = "com.github.idea-claude-code-gui"; // 兜底值
                    }
                }
            }
        }
        return cachedPluginId;
    }

    /**
     * 检查插件是否在开发模式下运行.
     * 通过多个标志判断：插件路径、系统路径、内部标志等。
     *
     * @return true 表示开发模式
     */
    public static boolean isPluginDevMode() {
        try {
            // 检查系统路径是否包含 sandbox（runIde 的典型特征）
            String systemPath = System.getProperty("idea.system.path");
            if (systemPath != null && systemPath.contains("sandbox")) {
                LOG.info("Dev mode detected: sandbox system path");
                return true;
            }

            // 检查插件路径是否包含 build
            String pluginsPath = System.getProperty("idea.plugins.path");
            if (pluginsPath != null && pluginsPath.contains("build")) {
                LOG.info("Dev mode detected: build plugins path");
                return true;
            }

            // 检查插件实际路径
            IdeaPluginDescriptor plugin = PluginManagerCore.getPlugin(
                    PluginId.getId(getPluginId())
            );
            if (plugin != null) {
                String pluginPath = plugin.getPluginPath().toString();
                if (pluginPath.contains("build")) {
                    LOG.info("Dev mode detected: plugin path contains build");
                    return true;
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to detect plugin dev mode: " + e.getMessage());
        }
        return false;
    }

    // ==================== 环境变量处理 ====================

    /**
     * 大小写不敏感地获取环境变量（适用于 Windows）
     * Windows 环境变量名称大小写不敏感，但 Java 的 System.getenv() 返回的 Map 是大小写敏感的
     *
     * @param name 环境变量名称
     * @return 环境变量值，如果不存在返回 null
     */
    public static String getEnvIgnoreCase(String name) {
        if (name == null) {
            return null;
        }

        // 首先尝试精确匹配
        String value = System.getenv(name);
        if (value != null) {
            return value;
        }

        // 如果是 Windows，进行大小写不敏感搜索
        if (isWindows()) {
            for (Map.Entry<String, String> entry : System.getenv().entrySet()) {
                if (entry.getKey().equalsIgnoreCase(name)) {
                    return entry.getValue();
                }
            }
        }

        return null;
    }

    /**
     * 获取 PATH 环境变量（兼容 Windows 的 Path 和 PATH）
     * @return PATH 环境变量值
     */
    public static String getPathEnv() {
        return getEnvIgnoreCase("PATH");
    }

    // ==================== 文件操作 ====================

    /**
     * 带重试机制的文件删除（处理 Windows 文件锁定问题）
     *
     * @param file 要删除的文件
     * @param maxRetries 最大重试次数
     * @return true 如果删除成功
     */
    public static boolean deleteWithRetry(File file, int maxRetries) {
        if (file == null || !file.exists()) {
            return true;
        }

        for (int attempt = 0; attempt < maxRetries; attempt++) {
            if (file.delete()) {
                return true;
            }

            if (attempt < maxRetries - 1) {
                try {
                    // 指数退避：200ms, 400ms, 800ms
                    long waitTime = 200L * (1L << attempt);
                    Thread.sleep(waitTime);
                    // 提示垃圾回收，可能释放文件句柄
                    System.gc();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        LOG.warn("⚠️ 文件删除失败（可能被锁定）: " + file.getAbsolutePath());
        return false;
    }

    /**
     * 带重试机制的目录删除（递归删除）
     *
     * @param directory 要删除的目录
     * @param maxRetries 最大重试次数
     * @return true 如果删除成功
     */
    public static boolean deleteDirectoryWithRetry(File directory, int maxRetries) {
        if (directory == null || !directory.exists()) {
            return true;
        }

        if (directory.isFile()) {
            return deleteWithRetry(directory, maxRetries);
        }

        // 递归删除子文件和子目录
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) {
                if (!deleteDirectoryWithRetry(file, maxRetries)) {
                    return false;
                }
            }
        }

        // 删除空目录
        return deleteWithRetry(directory, maxRetries);
    }

    // ==================== 进程管理 ====================

    /**
     * 终止进程树（包括所有子进程）
     * Windows 上使用 taskkill /F /T /PID，Unix 上使用标准的 destroy/destroyForcibly
     *
     * @param process 要终止的进程
     */
    public static void terminateProcess(Process process) {
        if (process == null || !process.isAlive()) {
            return;
        }

        try {
            if (isWindows()) {
                // 获取进程 ID
                long pid = process.pid();
                // 使用 taskkill 终止进程树
                // /F = 强制终止
                // /T = 终止进程树（包括子进程）
                ProcessBuilder pb = new ProcessBuilder(
                    "taskkill", "/F", "/T", "/PID", String.valueOf(pid)
                );
                pb.redirectErrorStream(true);
                Process killer = pb.start();
                boolean finished = killer.waitFor(5, TimeUnit.SECONDS);
                if (!finished) {
                    killer.destroyForcibly();
                }
            } else {
                ProcessHandle handle = process.toHandle();
                List<ProcessHandle> descendants = new ArrayList<>();
                try {
                    handle.descendants().forEach(descendants::add);
                } catch (Exception ignored) {
                }

                for (ProcessHandle child : descendants) {
                    try {
                        child.destroy();
                    } catch (Exception ignored) {
                    }
                }

                process.destroy();
                if (!process.waitFor(3, TimeUnit.SECONDS)) {
                    for (ProcessHandle child : descendants) {
                        try {
                            if (child.isAlive()) {
                                child.destroyForcibly();
                            }
                        } catch (Exception ignored) {
                        }
                    }
                    process.destroyForcibly();
                }
            }
        } catch (Exception e) {
            try {
                try {
                    ProcessHandle handle = process.toHandle();
                    List<ProcessHandle> descendants = new ArrayList<>();
                    try {
                        handle.descendants().forEach(descendants::add);
                    } catch (Exception ignored) {
                    }
                    for (ProcessHandle child : descendants) {
                        try {
                            child.destroyForcibly();
                        } catch (Exception ignored) {
                        }
                    }
                } catch (Exception ignored) {
                }
                process.destroyForcibly();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 通过 PID 终止进程树
     *
     * @param pid 进程 ID
     * @return true 如果终止命令执行成功
     */
    public static boolean terminateProcessTree(long pid) {
        try {
            if (isWindows()) {
                ProcessBuilder pb = new ProcessBuilder(
                    "taskkill", "/F", "/T", "/PID", String.valueOf(pid)
                );
                pb.redirectErrorStream(true);
                Process killer = pb.start();
                return killer.waitFor(5, TimeUnit.SECONDS);
            } else {
                // Unix: 尝试使用 kill 命令
                ProcessBuilder pb = new ProcessBuilder(
                    "kill", "-9", String.valueOf(pid)
                );
                pb.redirectErrorStream(true);
                Process killer = pb.start();
                return killer.waitFor(3, TimeUnit.SECONDS);
            }
        } catch (Exception e) {
            LOG.warn("⚠️ 终止进程失败 (PID: " + pid + "): " + e.getMessage());
            return false;
        }
    }

    // ==================== 辅助方法 ====================

    /**
     * 获取操作系统名称
     * @return 操作系统名称
     */
    public static String getOsName() {
        return System.getProperty("os.name", "Unknown");
    }

    /**
     * 获取操作系统版本
     * @return 操作系统版本
     */
    public static String getOsVersion() {
        return System.getProperty("os.version", "Unknown");
    }

    /**
     * 获取用户主目录
     * @return 用户主目录路径
     */
    public static String getHomeDirectory() {
        return System.getProperty("user.home", "");
    }

    /**
     * 获取系统临时目录
     * @return 临时目录路径
     */
    public static String getTempDirectory() {
        return System.getProperty("java.io.tmpdir", "");
    }

    /**
     * 获取 Windows 最大路径长度
     * @return 最大路径长度（Windows 为 260，其他平台为 4096）
     */
    public static int getMaxPathLength() {
        return isWindows() ? 260 : 4096;
    }
}
