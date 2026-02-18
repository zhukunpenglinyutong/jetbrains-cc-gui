package com.github.claudecodegui.util;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;

import java.io.File;
import java.lang.management.ManagementFactory;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Platform utility class.
 * Provides cross-platform compatibility support including platform detection,
 * environment variable handling, and process management.
 */
public class PlatformUtils {

    private static final Logger LOG = Logger.getInstance(PlatformUtils.class);

    // Platform type cache
    private static volatile PlatformType cachedPlatformType = null;
    // Plugin ID cache
    private static volatile String cachedPluginId = null;
    // Dev mode cache: null = not initialized, Boolean = cached result
    private static volatile Boolean cachedDevMode = null;

    /**
     * Platform type enumeration.
     */
    public enum PlatformType {
        WINDOWS,
        MACOS,
        LINUX,
        UNKNOWN
    }

    // ==================== Platform Detection ====================

    /**
     * Get the current platform type.
     * @return the platform type enum value
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
     * Check whether the current platform is Windows.
     * @return true if running on Windows
     */
    public static boolean isWindows() {
        return getPlatformType() == PlatformType.WINDOWS;
    }

    /**
     * Check whether the current platform is macOS.
     * @return true if running on macOS
     */
    public static boolean isMac() {
        return getPlatformType() == PlatformType.MACOS;
    }

    /**
     * Check whether the current platform is Linux.
     * @return true if running on Linux
     */
    public static boolean isLinux() {
        return getPlatformType() == PlatformType.LINUX;
    }

    /**
     * Get the current plugin ID.
     * Automatically detects the ID by iterating over all plugins and matching the classloader,
     * avoiding hardcoded values.
     *
     * @return the plugin ID, or a fallback value if detection fails
     */
    public static String getPluginId() {
        if (cachedPluginId == null) {
            synchronized (PlatformUtils.class) {
                if (cachedPluginId == null) {
                    try {
                        // Get the classloader for the current class
                        ClassLoader classLoader = PlatformUtils.class.getClassLoader();

                        // Iterate over all plugins to find the one containing the current class
                        for (IdeaPluginDescriptor plugin : PluginManagerCore.getPlugins()) {
                            if (plugin.getPluginClassLoader() == classLoader) {
                                cachedPluginId = plugin.getPluginId().getIdString();
                                LOG.info("Plugin ID detected: " + cachedPluginId);
                                return cachedPluginId;
                            }
                        }

                        // If no matching plugin found, use fallback value
                        LOG.warn("Failed to detect plugin ID: no matching plugin found");
                        cachedPluginId = "com.github.idea-claude-code-gui"; // fallback value
                    } catch (Exception e) {
                        LOG.warn("Failed to detect plugin ID: " + e.getMessage());
                        cachedPluginId = "com.github.idea-claude-code-gui"; // fallback value
                    }
                }
            }
        }
        return cachedPluginId;
    }

    /**
     * Check if the plugin is running in development mode.
     * Detection is based on multiple indicators: IDE Internal Mode, debugger attachment,
     * sandbox paths, build directories, etc.
     * <p>
     * The result is cached on first call to avoid repeated checks.
     * Uses double-checked locking for thread safety.
     *
     * @return true if running in development mode
     */
    public static boolean isPluginDevMode() {
        // Fast path: return cached value if already computed
        if (cachedDevMode != null) {
            return cachedDevMode;
        }

        // Double-checked locking to ensure single computation
        synchronized (PlatformUtils.class) {
            if (cachedDevMode == null) {
                cachedDevMode = computeDevMode();
            }
        }
        return cachedDevMode;
    }

    /**
     * Compute whether the plugin is running in development mode.
     * This method performs the actual detection logic.
     *
     * @return true if running in development mode
     */
    private static boolean computeDevMode() {
        try {
            // Check if IDE is running in Internal Mode
            var app = ApplicationManager.getApplication();
            if (app != null && app.isInternal()) {
                LOG.info("Dev mode detected: IDE Internal Mode enabled");
                return true;
            }

            // Check if a debugger is attached to the JVM
            if (isDebuggerAttached()) {
                LOG.info("Dev mode detected: debugger attached");
                return true;
            }

            // Check if system path contains sandbox (typical for runIde)
            String systemPath = System.getProperty("idea.system.path");
            if (systemPath != null && systemPath.contains("sandbox")) {
                LOG.info("Dev mode detected: sandbox system path");
                return true;
            }

            // Check if plugins path contains build
            String pluginsPath = System.getProperty("idea.plugins.path");
            if (pluginsPath != null && pluginsPath.contains("build")) {
                LOG.info("Dev mode detected: build plugins path");
                return true;
            }

            // Check plugin actual path
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

        LOG.info("Dev mode not detected, running in production mode");
        return false;
    }

    /**
     * Check if a debugger is attached to the JVM.
     * Detection is based on common debug agent flags in JVM input arguments.
     *
     * @return true if debugger is detected
     */
    private static boolean isDebuggerAttached() {
        try {
            return ManagementFactory.getRuntimeMXBean().getInputArguments().stream()
                    .anyMatch(arg -> arg.contains("-agentlib:jdwp") ||
                            arg.contains("-Xdebug") ||
                            arg.contains("-Xrunjdwp"));
        } catch (Exception e) {
            LOG.warn("Failed to check debugger attachment: " + e.getMessage());
        }
        return false;
    }

    // ==================== Environment Variable Handling ====================

    /**
     * Get an environment variable with case-insensitive lookup (for Windows compatibility).
     * Windows environment variable names are case-insensitive, but Java's System.getenv()
     * returns a case-sensitive Map.
     *
     * @param name the environment variable name
     * @return the environment variable value, or null if not found
     */
    public static String getEnvIgnoreCase(String name) {
        if (name == null) {
            return null;
        }

        // Try exact match first
        String value = System.getenv(name);
        if (value != null) {
            return value;
        }

        // On Windows, perform case-insensitive search
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
     * Get the PATH environment variable (handles both "Path" and "PATH" on Windows).
     * @return the PATH environment variable value
     */
    public static String getPathEnv() {
        return getEnvIgnoreCase("PATH");
    }

    // ==================== File Operations ====================

    /**
     * Delete a file with retry logic (handles Windows file locking issues).
     *
     * @param file the file to delete
     * @param maxRetries maximum number of retry attempts
     * @return true if deletion succeeded
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
                    // Exponential backoff: 200ms, 400ms, 800ms
                    long waitTime = 200L * (1L << attempt);
                    Thread.sleep(waitTime);
                    // Hint the GC, which may release file handles
                    System.gc();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        LOG.warn("Failed to delete file (possibly locked): " + file.getAbsolutePath());
        return false;
    }

    /**
     * Recursively delete a directory with retry logic.
     *
     * @param directory the directory to delete
     * @param maxRetries maximum number of retry attempts
     * @return true if deletion succeeded
     */
    public static boolean deleteDirectoryWithRetry(File directory, int maxRetries) {
        if (directory == null || !directory.exists()) {
            return true;
        }

        if (directory.isFile()) {
            return deleteWithRetry(directory, maxRetries);
        }

        // Recursively delete child files and subdirectories
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) {
                if (!deleteDirectoryWithRetry(file, maxRetries)) {
                    return false;
                }
            }
        }

        // Delete the now-empty directory
        return deleteWithRetry(directory, maxRetries);
    }

    // ==================== Process Management ====================

    /**
     * Terminate a process tree (including all child processes).
     * On Windows, uses taskkill /F /T /PID. On Unix, uses the standard destroy/destroyForcibly.
     *
     * @param process the process to terminate
     */
    public static void terminateProcess(Process process) {
        if (process == null || !process.isAlive()) {
            return;
        }

        try {
            if (isWindows()) {
                // Get the process ID
                long pid = process.pid();
                // Use taskkill to terminate the process tree
                // /F = force termination
                // /T = terminate the entire process tree (including children)
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
     * Terminate a process tree by PID.
     *
     * @param pid the process ID
     * @return true if the termination command executed successfully
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
                // Unix: try using the kill command
                ProcessBuilder pb = new ProcessBuilder(
                    "kill", "-9", String.valueOf(pid)
                );
                pb.redirectErrorStream(true);
                Process killer = pb.start();
                return killer.waitFor(3, TimeUnit.SECONDS);
            }
        } catch (Exception e) {
            LOG.warn("Failed to terminate process (PID: " + pid + "): " + e.getMessage());
            return false;
        }
    }

    // ==================== Helper Methods ====================

    /**
     * Get the operating system name.
     * @return the OS name
     */
    public static String getOsName() {
        return System.getProperty("os.name", "Unknown");
    }

    /**
     * Get the operating system version.
     * @return the OS version
     */
    public static String getOsVersion() {
        return System.getProperty("os.version", "Unknown");
    }

    /**
     * Get the user's home directory.
     * @return the home directory path
     */
    public static String getHomeDirectory() {
        return System.getProperty("user.home", "");
    }

    /**
     * Get the system temporary directory.
     * @return the temporary directory path
     */
    public static String getTempDirectory() {
        return System.getProperty("java.io.tmpdir", "");
    }

    /**
     * Get the maximum path length for the current platform.
     * @return the maximum path length (260 for Windows, 4096 for other platforms)
     */
    public static int getMaxPathLength() {
        return isWindows() ? 260 : 4096;
    }
}
