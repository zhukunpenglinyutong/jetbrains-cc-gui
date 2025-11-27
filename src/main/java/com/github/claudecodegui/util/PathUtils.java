package com.github.claudecodegui.util;

import com.github.claudecodegui.model.PathCheckResult;

import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 路径工具类
 * 提供跨平台的路径处理方法，包括路径规范化、路径检查、临时目录检测等
 */
public class PathUtils {

    // Windows 路径长度限制
    private static final int WINDOWS_MAX_PATH = 260;
    private static final int SAFE_PATH_LENGTH = 200; // 留出余量给文件名

    // ==================== 路径规范化方法 ====================

    /**
     * 将路径转换为安全的文件名/标识符
     * 与 Claude Code 的 sanitizedPath 逻辑保持一致
     * 将所有非字母数字字符替换为 -
     *
     * @param path 原始路径
     * @return 规范化后的路径字符串（非字母数字字符替换为 -）
     */
    public static String sanitizePath(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        // 与 Claude Code 保持一致：将所有非字母数字字符替换为 -
        // 这样 D:\Projects\MyProject 会变成 D--Projects-MyProject
        return path.replaceAll("[^a-zA-Z0-9]", "-");
    }

    /**
     * 将路径规范化为 Unix 风格（用于内部存储和比较）
     * 将 Windows 反斜杠转换为正斜杠
     *
     * @param path 原始路径
     * @return 使用正斜杠的路径
     */
    public static String normalizeToUnix(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        return path.replace("\\", "/");
    }

    /**
     * 将路径规范化为当前平台风格
     *
     * @param path 原始路径
     * @return 使用当前平台分隔符的路径
     */
    public static String normalizeToPlatform(String path) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        if (PlatformUtils.isWindows()) {
            return path.replace("/", "\\");
        } else {
            return path.replace("\\", "/");
        }
    }

    /**
     * 检查路径是否为 Windows 格式（包含驱动器盘符）
     *
     * @param path 要检查的路径
     * @return true 如果是 Windows 路径格式
     */
    public static boolean isWindowsPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        // 检查是否以驱动器盘符开头（如 C:, D:）
        return path.matches("^[a-zA-Z]:.*");
    }

    /**
     * 检查路径是否为 UNC 路径（网络路径）
     *
     * @param path 要检查的路径
     * @return true 如果是 UNC 路径
     */
    public static boolean isUncPath(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return path.startsWith("\\\\") || path.startsWith("//");
    }

    // ==================== 路径长度检查 ====================

    /**
     * 检查路径长度是否安全（主要用于 Windows）
     *
     * @param path 要检查的路径
     * @return PathCheckResult 包含检查结果和建议
     */
    public static PathCheckResult checkPathLength(String path) {
        if (path == null || path.isEmpty()) {
            return PathCheckResult.ok();
        }

        // 非 Windows 平台不需要检查
        if (!PlatformUtils.isWindows()) {
            return PathCheckResult.ok();
        }

        int pathLength = path.length();

        if (pathLength >= WINDOWS_MAX_PATH) {
            return PathCheckResult.error(
                "项目路径过长（" + pathLength + " 字符）\n" +
                "Windows 限制路径长度为 260 字符。\n" +
                "建议：将项目移动到更短的路径，如 D:\\projects\\",
                path,
                pathLength
            );
        }

        if (pathLength >= SAFE_PATH_LENGTH) {
            return PathCheckResult.warning(
                "项目路径较长（" + pathLength + " 字符）\n" +
                "可能在创建深层文件时超出 Windows 路径限制。",
                path,
                pathLength
            );
        }

        return PathCheckResult.ok(path, pathLength);
    }

    // ==================== 临时目录检测 ====================

    /**
     * 获取所有可能的临时目录路径
     *
     * @return 临时目录路径列表
     */
    public static List<String> getTempPaths() {
        Set<String> paths = new HashSet<>();

        // 系统临时目录
        String javaTmpDir = System.getProperty("java.io.tmpdir");
        if (javaTmpDir != null && !javaTmpDir.isEmpty()) {
            paths.add(normalizeToUnix(javaTmpDir).toLowerCase());
        }

        if (PlatformUtils.isWindows()) {
            // Windows 特定临时目录
            String temp = PlatformUtils.getEnvIgnoreCase("TEMP");
            if (temp != null && !temp.isEmpty()) {
                paths.add(normalizeToUnix(temp).toLowerCase());
            }

            String tmp = PlatformUtils.getEnvIgnoreCase("TMP");
            if (tmp != null && !tmp.isEmpty()) {
                paths.add(normalizeToUnix(tmp).toLowerCase());
            }

            String localAppData = PlatformUtils.getEnvIgnoreCase("LOCALAPPDATA");
            if (localAppData != null && !localAppData.isEmpty()) {
                paths.add(normalizeToUnix(localAppData + "\\Temp").toLowerCase());
            }

            // 常见 Windows 临时目录
            paths.add("c:/windows/temp");
        } else {
            // Unix 系统临时目录
            paths.add("/tmp");
            paths.add("/var/tmp");
            paths.add("/private/tmp"); // macOS

            String tmpDir = System.getenv("TMPDIR");
            if (tmpDir != null && !tmpDir.isEmpty()) {
                paths.add(normalizeToUnix(tmpDir).toLowerCase());
            }
        }

        return new ArrayList<>(paths);
    }

    /**
     * 检查给定路径是否为临时目录
     *
     * @param path 要检查的路径
     * @return true 如果路径是临时目录或位于临时目录下
     */
    public static boolean isTempDirectory(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }

        String normalizedPath = normalizeToUnix(path).toLowerCase();
        List<String> tempPaths = getTempPaths();

        for (String tempPath : tempPaths) {
            if (tempPath != null && normalizedPath.startsWith(tempPath)) {
                return true;
            }
        }

        return false;
    }

    // ==================== 路径验证 ====================

    /**
     * 验证路径是否可写
     *
     * @param path 要验证的路径
     * @return true 如果路径存在且可写
     */
    public static boolean isWritable(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        File file = new File(path);
        return file.exists() && file.canWrite();
    }

    /**
     * 验证路径是否存在
     *
     * @param path 要验证的路径
     * @return true 如果路径存在
     */
    public static boolean exists(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        return new File(path).exists();
    }

    /**
     * 获取路径的父目录
     *
     * @param path 文件或目录路径
     * @return 父目录路径，如果无法获取返回 null
     */
    public static String getParentPath(String path) {
        if (path == null || path.isEmpty()) {
            return null;
        }
        File file = new File(path);
        File parent = file.getParentFile();
        return parent != null ? parent.getAbsolutePath() : null;
    }

    /**
     * 合并路径
     *
     * @param basePath 基础路径
     * @param relativePath 相对路径
     * @return 合并后的路径
     */
    public static String joinPath(String basePath, String relativePath) {
        if (basePath == null || basePath.isEmpty()) {
            return relativePath;
        }
        if (relativePath == null || relativePath.isEmpty()) {
            return basePath;
        }
        return new File(basePath, relativePath).getAbsolutePath();
    }
}
