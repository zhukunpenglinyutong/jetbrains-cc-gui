package com.github.claudecodegui.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Claude Code CLI detection result class.
 * Represents the detailed outcome of a CLI detection process.
 */
public class CliDetectionResult {

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
        PATH_VARIABLE
    }

    private final boolean found;
    private final String cliPath;
    private final String cliVersion;
    private final DetectionMethod method;
    private final List<String> triedPaths;
    private final String errorMessage;

    /**
     * Private constructor.
     */
    private CliDetectionResult(boolean found, String cliPath, String cliVersion,
                               DetectionMethod method, List<String> triedPaths, String errorMessage) {
        this.found = found;
        this.cliPath = cliPath;
        this.cliVersion = cliVersion;
        this.method = method;
        this.triedPaths = triedPaths != null ? new ArrayList<>(triedPaths) : new ArrayList<>();
        this.errorMessage = errorMessage;
    }

    // ==================== Factory Methods ====================

    /**
     * Creates a successful result.
     *
     * @param cliPath path to the CLI executable
     * @param cliVersion CLI version string
     * @param method the detection method used
     * @return a successful CliDetectionResult
     */
    public static CliDetectionResult success(String cliPath, String cliVersion, DetectionMethod method) {
        return new CliDetectionResult(true, cliPath, cliVersion, method, null, null);
    }

    /**
     * Creates a successful result with the list of paths that were tried.
     *
     * @param cliPath path to the CLI executable
     * @param cliVersion CLI version string
     * @param method the detection method used
     * @param triedPaths list of paths that were attempted
     * @return a successful CliDetectionResult
     */
    public static CliDetectionResult success(String cliPath, String cliVersion,
                                             DetectionMethod method, List<String> triedPaths) {
        return new CliDetectionResult(true, cliPath, cliVersion, method, triedPaths, null);
    }

    /**
     * Creates a failure result.
     *
     * @param errorMessage the error message
     * @return a failed CliDetectionResult
     */
    public static CliDetectionResult failure(String errorMessage) {
        return new CliDetectionResult(false, null, null, null, null, errorMessage);
    }

    /**
     * Creates a failure result with the list of paths that were tried.
     *
     * @param errorMessage the error message
     * @param triedPaths list of paths that were attempted
     * @return a failed CliDetectionResult
     */
    public static CliDetectionResult failure(String errorMessage, List<String> triedPaths) {
        return new CliDetectionResult(false, null, null, null, triedPaths, errorMessage);
    }

    // ==================== Getters ====================

    /**
     * Returns whether CLI was found.
     * @return true if CLI was detected
     */
    public boolean isFound() {
        return found;
    }

    /**
     * Gets the path to the CLI executable.
     * @return the CLI path, or null if not found
     */
    public String getCliPath() {
        return cliPath;
    }

    /**
     * Gets the CLI version.
     * @return the version string, or null if not found
     */
    public String getCliVersion() {
        return cliVersion;
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
     * Gets a user-friendly error description suitable for display.
     * @return a description including error details and installation suggestions
     */
    public String getUserFriendlyMessage() {
        if (found) {
            return "Claude Code CLI 检测成功：" + cliPath + " (" + cliVersion + ")";
        }

        StringBuilder sb = new StringBuilder();
        sb.append("未找到 Claude Code CLI\n\n");

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
            sb.append("1. 使用 npm 安装: npm install -g @anthropic-ai/claude-code\n");
            sb.append("2. 安装完成后，重启 IntelliJ IDEA\n");
        } else if (osName.contains("mac")) {
            sb.append("macOS 安装建议：\n");
            sb.append("1. 使用 npm 安装: npm install -g @anthropic-ai/claude-code\n");
        } else {
            sb.append("Linux 安装建议：\n");
            sb.append("1. 使用 npm 安装: npm install -g @anthropic-ai/claude-code\n");
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
            default:
                return "未知";
        }
    }

    @Override
    public String toString() {
        return "CliDetectionResult{" +
                "found=" + found +
                ", cliPath='" + cliPath + '\'' +
                ", cliVersion='" + cliVersion + '\'' +
                ", method=" + method +
                ", triedPaths=" + triedPaths +
                ", errorMessage='" + errorMessage + '\'' +
                '}';
    }
}
