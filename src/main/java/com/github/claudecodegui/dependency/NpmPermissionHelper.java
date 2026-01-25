package com.github.claudecodegui.dependency;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * npm 权限问题检测和修复工具
 */
public class NpmPermissionHelper {
    private static final Logger LOG = Logger.getInstance(NpmPermissionHelper.class);

    // 权限错误关键词
    private static final Pattern PERMISSION_ERROR_PATTERN = Pattern.compile(
        "EACCES|EPERM|permission denied|access denied|ENOTEMPTY.*_cacache",
        Pattern.CASE_INSENSITIVE
    );

    // 缓存冲突关键词
    private static final Pattern CACHE_ERROR_PATTERN = Pattern.compile(
        "File exists.*_cacache|EEXIST.*_cacache|Invalid response body",
        Pattern.CASE_INSENSITIVE
    );

    // Windows shell 需要转义的特殊字符
    private static final Pattern WINDOWS_SPECIAL_CHARS = Pattern.compile("[\\^~<>|&()\\s]");

    /**
     * 检测日志中是否包含权限错误
     */
    public static boolean hasPermissionError(String logs) {
        if (logs == null || logs.isEmpty()) {
            return false;
        }
        return PERMISSION_ERROR_PATTERN.matcher(logs).find();
    }

    /**
     * 检测日志中是否包含缓存错误
     */
    public static boolean hasCacheError(String logs) {
        if (logs == null || logs.isEmpty()) {
            return false;
        }
        return CACHE_ERROR_PATTERN.matcher(logs).find();
    }

    /**
     * 获取 npm 缓存目录
     */
    public static Path getNpmCacheDir() {
        String userHome = System.getProperty("user.home");
        return Paths.get(userHome, ".npm", "_cacache");
    }

    /**
     * 检查 npm 缓存目录是否有权限问题
     */
    public static boolean checkCachePermission() {
        try {
            Path cacheDir = getNpmCacheDir();
            if (!Files.exists(cacheDir)) {
                return true; // 不存在则没问题
            }

            // 尝试在缓存目录创建测试文件
            Path testFile = cacheDir.resolve(".permission-test-" + System.currentTimeMillis());
            try {
                Files.createFile(testFile);
                Files.delete(testFile);
                return true; // 有写权限
            } catch (Exception e) {
                LOG.warn("[NpmPermissionHelper] Cache directory has permission issues: " + e.getMessage());
                return false; // 无写权限
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to check cache permission: " + e.getMessage(), e);
            return true; // 无法检查，假设没问题
        }
    }

    /**
     * 清理 npm 缓存（方案1）
     * @param npmPath npm 可执行文件路径
     * @return true 如果清理成功
     */
    public static boolean cleanNpmCache(String npmPath) {
        try {
            LOG.info("[NpmPermissionHelper] Attempting to clean npm cache using: npm cache clean --force");

            ProcessBuilder pb = new ProcessBuilder(npmPath, "cache", "clean", "--force");
            Process process = pb.start();

            // 读取输出（可能有警告信息）
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            boolean finished = process.waitFor(60, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                LOG.warn("[NpmPermissionHelper] npm cache clean timed out");
                return false;
            }

            int exitCode = process.exitValue();
            if (exitCode == 0) {
                LOG.info("[NpmPermissionHelper] npm cache cleaned successfully");
                return true;
            } else {
                LOG.warn("[NpmPermissionHelper] npm cache clean failed with exit code: " + exitCode);
                LOG.debug("[NpmPermissionHelper] Output: " + output);
                return false;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to clean npm cache: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * 手动删除 npm 缓存目录（方案2 - 更激进）
     * @return true 如果删除成功
     */
    public static boolean forceDeleteCache() {
        try {
            Path cacheDir = getNpmCacheDir();
            if (!Files.exists(cacheDir)) {
                LOG.info("[NpmPermissionHelper] Cache directory does not exist, nothing to delete");
                return true;
            }

            LOG.info("[NpmPermissionHelper] Force deleting cache directory: " + cacheDir);

            if (PlatformUtils.isWindows()) {
                // Windows: 使用 rmdir /s /q
                ProcessBuilder pb = new ProcessBuilder("cmd", "/c", "rmdir", "/s", "/q", cacheDir.toString());
                Process process = pb.start();
                boolean finished = process.waitFor(30, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                }
                return process.exitValue() == 0;
            } else {
                // Unix: 使用 rm -rf
                ProcessBuilder pb = new ProcessBuilder("rm", "-rf", cacheDir.toString());
                Process process = pb.start();
                boolean finished = process.waitFor(30, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                }
                return process.exitValue() == 0;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to force delete cache: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * 修复缓存目录权限（Unix only）
     * @return true 如果修复成功或不需要修复
     */
    public static boolean fixCacheOwnership() {
        if (PlatformUtils.isWindows()) {
            // Windows 不需要修复所有者
            return true;
        }

        try {
            Path cacheDir = getNpmCacheDir().getParent(); // ~/.npm
            if (!Files.exists(cacheDir)) {
                return true;
            }

            String currentUser = System.getProperty("user.name");
            LOG.info("[NpmPermissionHelper] Attempting to fix ownership of: " + cacheDir + " to user: " + currentUser);

            // 使用 sudo chown -R
            ProcessBuilder pb = new ProcessBuilder("sudo", "chown", "-R", currentUser, cacheDir.toString());
            Process process = pb.start();

            boolean finished = process.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return false;
            }

            if (process.exitValue() == 0) {
                LOG.info("[NpmPermissionHelper] Ownership fixed successfully");
                return true;
            } else {
                LOG.warn("[NpmPermissionHelper] Failed to fix ownership (exit code: " + process.exitValue() + ")");
                return false;
            }
        } catch (Exception e) {
            LOG.error("[NpmPermissionHelper] Failed to fix cache ownership: " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * 构建带有权限修复策略的 npm install 命令
     */
    public static List<String> buildInstallCommandWithFallback(
            String npmPath, Path sdkDir, List<String> packages, int retryAttempt) {

        List<String> command = new ArrayList<>();
        command.add(npmPath);
        command.add("install");
        command.add("--prefix");
        command.add(sdkDir.toString());

        // 第二次重试：使用 --force 强制覆盖
        if (retryAttempt > 0) {
            command.add("--force");
            LOG.info("[NpmPermissionHelper] Adding --force flag for retry attempt " + retryAttempt);
        }

        // On Windows, wrap packages containing shell special characters in quotes to prevent
        // cmd.exe from interpreting them. Unix systems don't need this as ProcessBuilder
        // passes arguments directly via execve() without shell interpretation.
        boolean needsQuoting = PlatformUtils.isWindows();
        for (String pkg : packages) {
            if (needsQuoting && WINDOWS_SPECIAL_CHARS.matcher(pkg).find()) {
                // Escape any existing quotes in the package name and wrap in quotes
                command.add("\"" + pkg.replace("\"", "\\\"") + "\"");
            } else {
                command.add(pkg);
            }
        }

        return command;
    }

    /**
     * 生成用户友好的错误提示
     */
    public static String generateErrorSolution(String logs) {
        StringBuilder solution = new StringBuilder();

        if (hasPermissionError(logs)) {
            solution.append("\n\n🔧 Detected npm permission error. Possible solutions:\n");
            solution.append("1. Run: npm cache clean --force\n");
            solution.append("2. Or manually delete: ~/.npm/_cacache\n");
            if (!PlatformUtils.isWindows()) {
                solution.append("3. Fix ownership: sudo chown -R $(whoami) ~/.npm\n");
            }
        } else if (hasCacheError(logs)) {
            solution.append("\n\n🔧 Detected npm cache conflict. Possible solutions:\n");
            solution.append("1. Clean cache: npm cache clean --force\n");
            solution.append("2. Or delete cache: rm -rf ~/.npm/_cacache\n");
        }

        return solution.toString();
    }
}
