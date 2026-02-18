package com.github.claudecodegui.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Node.js detection result class.
 * Represents the detailed outcome of a Node.js detection process.
 */
public class NodeDetectionResult {

    /**
     * Detection method enum.
     */
    public enum DetectionMethod {
        /** Windows "where" command */
        WHERE_COMMAND,
        /** Unix "which" command */
        WHICH_COMMAND,
        /** Known installation path */
        KNOWN_PATH,
        /** PATH environment variable */
        PATH_VARIABLE,
        /** Direct node invocation (fallback) */
        FALLBACK
    }

    private final boolean found;
    private final String nodePath;
    private final String nodeVersion;
    private final DetectionMethod method;
    private final List<String> triedPaths;
    private final String errorMessage;

    /**
     * Private constructor.
     */
    private NodeDetectionResult(boolean found, String nodePath, String nodeVersion,
                                DetectionMethod method, List<String> triedPaths, String errorMessage) {
        this.found = found;
        this.nodePath = nodePath;
        this.nodeVersion = nodeVersion;
        this.method = method;
        this.triedPaths = triedPaths != null ? new ArrayList<>(triedPaths) : new ArrayList<>();
        this.errorMessage = errorMessage;
    }

    // ==================== Factory Methods ====================

    /**
     * Creates a successful result.
     *
     * @param nodePath path to the Node.js executable
     * @param nodeVersion Node.js version string
     * @param method the detection method used
     * @return a successful NodeDetectionResult
     */
    public static NodeDetectionResult success(String nodePath, String nodeVersion, DetectionMethod method) {
        return new NodeDetectionResult(true, nodePath, nodeVersion, method, null, null);
    }

    /**
     * Creates a successful result with the list of paths that were tried.
     *
     * @param nodePath path to the Node.js executable
     * @param nodeVersion Node.js version string
     * @param method the detection method used
     * @param triedPaths list of paths that were attempted
     * @return a successful NodeDetectionResult
     */
    public static NodeDetectionResult success(String nodePath, String nodeVersion,
                                              DetectionMethod method, List<String> triedPaths) {
        return new NodeDetectionResult(true, nodePath, nodeVersion, method, triedPaths, null);
    }

    /**
     * Creates a failure result.
     *
     * @param errorMessage the error message
     * @return a failed NodeDetectionResult
     */
    public static NodeDetectionResult failure(String errorMessage) {
        return new NodeDetectionResult(false, null, null, null, null, errorMessage);
    }

    /**
     * Creates a failure result with the list of paths that were tried.
     *
     * @param errorMessage the error message
     * @param triedPaths list of paths that were attempted
     * @return a failed NodeDetectionResult
     */
    public static NodeDetectionResult failure(String errorMessage, List<String> triedPaths) {
        return new NodeDetectionResult(false, null, null, null, triedPaths, errorMessage);
    }

    // ==================== Getters ====================

    /**
     * Returns whether Node.js was found.
     * @return true if Node.js was detected
     */
    public boolean isFound() {
        return found;
    }

    /**
     * Gets the path to the Node.js executable.
     * @return the Node.js path, or null if not found
     */
    public String getNodePath() {
        return nodePath;
    }

    /**
     * Gets the Node.js version.
     * @return the version string (e.g. "v18.16.0"), or null if not found
     */
    public String getNodeVersion() {
        return nodeVersion;
    }

    /**
     * Gets the detection method used.
     * @return the detection method enum value, or null if not found
     */
    public DetectionMethod getMethod() {
        return method;
    }

    /**
     * Gets the list of paths that were tried during detection.
     * @return an unmodifiable list of paths
     */
    public List<String> getTriedPaths() {
        return Collections.unmodifiableList(triedPaths);
    }

    /**
     * Gets the error message.
     * @return the error message, or null if detection was successful
     */
    public String getErrorMessage() {
        return errorMessage;
    }

    // ==================== Convenience Methods ====================

    /**
     * Adds a path that was tried during detection (for internal use).
     * @param path the path that was attempted
     */
    public void addTriedPath(String path) {
        if (path != null && !path.isEmpty()) {
            this.triedPaths.add(path);
        }
    }

    /**
     * Gets a user-friendly error description suitable for display.
     * @return a description including error details and installation suggestions
     */
    public String getUserFriendlyMessage() {
        if (found) {
            return "Node.js 检测成功：" + nodePath + " (" + nodeVersion + ")";
        }

        StringBuilder sb = new StringBuilder();
        sb.append("未找到 Node.js\n\n");

        if (errorMessage != null && !errorMessage.isEmpty()) {
            sb.append("错误信息：").append(errorMessage).append("\n\n");
        }

        if (!triedPaths.isEmpty()) {
            sb.append("已尝试的路径：\n");
            for (String path : triedPaths) {
                sb.append("  - ").append(path).append("\n");
            }
            sb.append("\n");
        }

        // Provide platform-specific installation suggestions
        String osName = System.getProperty("os.name", "").toLowerCase();
        if (osName.contains("win")) {
            sb.append("Windows 安装建议：\n");
            sb.append("1. 从 https://nodejs.org/ 下载并安装 Node.js\n");
            sb.append("2. 安装完成后，重启 IntelliJ IDEA\n");
            sb.append("3. 确保 Node.js 安装目录已添加到系统 PATH 环境变量\n");
        } else if (osName.contains("mac")) {
            sb.append("macOS 安装建议：\n");
            sb.append("1. 使用 Homebrew: brew install node\n");
            sb.append("2. 或从 https://nodejs.org/ 下载安装包\n");
        } else {
            sb.append("Linux 安装建议：\n");
            sb.append("1. Ubuntu/Debian: sudo apt install nodejs\n");
            sb.append("2. CentOS/RHEL: sudo yum install nodejs\n");
            sb.append("3. 或使用 nvm: https://github.com/nvm-sh/nvm\n");
        }

        return sb.toString();
    }

    /**
     * Gets a human-readable description of the detection method.
     * @return detection method description
     */
    public String getMethodDescription() {
        if (method == null) {
            return "未知";
        }
        switch (method) {
            case WHERE_COMMAND:
                return "Windows where 命令";
            case WHICH_COMMAND:
                return "Unix which 命令";
            case KNOWN_PATH:
                return "已知安装路径";
            case PATH_VARIABLE:
                return "PATH 环境变量";
            case FALLBACK:
                return "直接调用 node";
            default:
                return "未知";
        }
    }

    @Override
    public String toString() {
        return "NodeDetectionResult{" +
                "found=" + found +
                ", nodePath='" + nodePath + '\'' +
                ", nodeVersion='" + nodeVersion + '\'' +
                ", method=" + method +
                ", triedPaths=" + triedPaths +
                ", errorMessage='" + errorMessage + '\'' +
                '}';
    }
}
