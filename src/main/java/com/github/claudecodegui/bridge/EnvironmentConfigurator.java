package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;

/**
 * 环境配置器
 * 负责配置进程环境变量
 */
public class EnvironmentConfigurator {

    private static final String CLAUDE_PERMISSION_ENV = "CLAUDE_PERMISSION_DIR";

    private volatile String cachedPermissionDir = null;

    /**
     * 更新进程的环境变量，确保 PATH 包含 Node.js 所在目录
     * 支持 Windows (Path) 和 Unix (PATH) 环境变量命名
     */
    public void updateProcessEnvironment(ProcessBuilder pb, String nodeExecutable) {
        Map<String, String> env = pb.environment();

        // 使用 PlatformUtils 获取 PATH 环境变量（大小写不敏感）
        String path = PlatformUtils.isWindows() ?
            PlatformUtils.getEnvIgnoreCase("PATH") :
            env.get("PATH");

        if (path == null) {
            path = "";
        }

        StringBuilder newPath = new StringBuilder(path);
        String separator = File.pathSeparator;

        // 1. 添加 Node.js 所在目录
        if (nodeExecutable != null && !nodeExecutable.equals("node")) {
            File nodeFile = new File(nodeExecutable);
            String nodeDir = nodeFile.getParent();
            if (nodeDir != null && !pathContains(path, nodeDir)) {
                newPath.append(separator).append(nodeDir);
            }
        }

        // 2. 根据平台添加常用路径
        if (PlatformUtils.isWindows()) {
            // Windows 常用路径
            String[] windowsPaths = {
                System.getenv("ProgramFiles") + "\\nodejs",
                System.getenv("APPDATA") + "\\npm",
                System.getenv("LOCALAPPDATA") + "\\Programs\\nodejs"
            };
            for (String p : windowsPaths) {
                if (p != null && !p.contains("null") && !pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        } else {
            // macOS/Linux 常用路径
            String[] unixPaths = {
                "/usr/local/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
                System.getProperty("user.home") + "/.nvm/current/bin"
            };
            for (String p : unixPaths) {
                if (!pathContains(path, p)) {
                    newPath.append(separator).append(p);
                }
            }
        }

        // 3. 设置 PATH 环境变量
        // Windows 需要同时设置 PATH 和 Path（某些程序只识别其中一个）
        String newPathStr = newPath.toString();
        if (PlatformUtils.isWindows()) {
            // 先移除可能存在的旧值，避免重复
            env.remove("PATH");
            env.remove("Path");
            env.remove("path");
            // 同时设置多种大小写形式确保兼容性
            env.put("PATH", newPathStr);
            env.put("Path", newPathStr);
        } else {
            env.put("PATH", newPathStr);
        }

        // 4. 确保 HOME 环境变量设置正确
        // SDK 需要 HOME 环境变量来找到 ~/.claude/commands/ 目录
        String home = env.get("HOME");
        if (home == null || home.isEmpty()) {
            home = System.getProperty("user.home");
            if (home != null && !home.isEmpty()) {
                env.put("HOME", home);
            }
        }

        configurePermissionEnv(env);
    }

    /**
     * 配置权限环境变量
     */
    public void configurePermissionEnv(Map<String, String> env) {
        if (env == null) {
            return;
        }
        String permissionDir = getPermissionDirectory();
        if (permissionDir != null) {
            env.putIfAbsent(CLAUDE_PERMISSION_ENV, permissionDir);
        }
    }

    /**
     * 获取权限目录
     */
    public String getPermissionDirectory() {
        String cached = this.cachedPermissionDir;
        if (cached != null) {
            return cached;
        }

        Path dir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            System.err.println("[EnvironmentConfigurator] Failed to prepare permission dir: " + dir + " (" + e.getMessage() + ")");
        }
        cachedPermissionDir = dir.toAbsolutePath().toString();
        return cachedPermissionDir;
    }

    /**
     * 检查 PATH 中是否已包含指定路径
     * Windows 下进行大小写不敏感比较
     */
    private boolean pathContains(String pathEnv, String targetPath) {
        if (pathEnv == null || targetPath == null) {
            return false;
        }
        if (PlatformUtils.isWindows()) {
            return pathEnv.toLowerCase().contains(targetPath.toLowerCase());
        }
        return pathEnv.contains(targetPath);
    }

    /**
     * 配置临时目录环境变量
     */
    public void configureTempDir(Map<String, String> env, File tempDir) {
        if (env == null || tempDir == null) {
            return;
        }
        String tmpPath = tempDir.getAbsolutePath();
        env.put("TMPDIR", tmpPath);
        env.put("TEMP", tmpPath);
        env.put("TMP", tmpPath);
    }

    /**
     * 配置项目路径环境变量
     */
    public void configureProjectPath(Map<String, String> env, String cwd) {
        if (env == null || cwd == null || cwd.isEmpty() || "undefined".equals(cwd) || "null".equals(cwd)) {
            return;
        }
        env.put("IDEA_PROJECT_PATH", cwd);
        env.put("PROJECT_PATH", cwd);
    }

    /**
     * 配置附件相关环境变量
     */
    public void configureAttachmentEnv(Map<String, String> env, boolean hasAttachments) {
        if (env == null) {
            return;
        }
        if (hasAttachments) {
            env.put("CLAUDE_USE_STDIN", "true");
        }
    }

    /**
     * 清除缓存
     */
    public void clearCache() {
        this.cachedPermissionDir = null;
    }
}
