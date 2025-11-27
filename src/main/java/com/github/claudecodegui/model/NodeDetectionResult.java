package com.github.claudecodegui.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Node.js 检测结果类
 * 用于表示 Node.js 检测过程的详细结果
 */
public class NodeDetectionResult {

    /**
     * 检测方法枚举
     */
    public enum DetectionMethod {
        /** Windows where 命令 */
        WHERE_COMMAND,
        /** Unix which 命令 */
        WHICH_COMMAND,
        /** 已知安装路径 */
        KNOWN_PATH,
        /** PATH 环境变量 */
        PATH_VARIABLE,
        /** 直接调用 node（回退方案） */
        FALLBACK
    }

    private final boolean found;
    private final String nodePath;
    private final String nodeVersion;
    private final DetectionMethod method;
    private final List<String> triedPaths;
    private final String errorMessage;

    /**
     * 私有构造函数
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

    // ==================== 工厂方法 ====================

    /**
     * 创建成功结果
     *
     * @param nodePath Node.js 可执行文件路径
     * @param nodeVersion Node.js 版本
     * @param method 检测方法
     * @return 成功的 NodeDetectionResult
     */
    public static NodeDetectionResult success(String nodePath, String nodeVersion, DetectionMethod method) {
        return new NodeDetectionResult(true, nodePath, nodeVersion, method, null, null);
    }

    /**
     * 创建成功结果（带尝试路径列表）
     *
     * @param nodePath Node.js 可执行文件路径
     * @param nodeVersion Node.js 版本
     * @param method 检测方法
     * @param triedPaths 尝试过的路径列表
     * @return 成功的 NodeDetectionResult
     */
    public static NodeDetectionResult success(String nodePath, String nodeVersion,
                                              DetectionMethod method, List<String> triedPaths) {
        return new NodeDetectionResult(true, nodePath, nodeVersion, method, triedPaths, null);
    }

    /**
     * 创建失败结果
     *
     * @param errorMessage 错误消息
     * @return 失败的 NodeDetectionResult
     */
    public static NodeDetectionResult failure(String errorMessage) {
        return new NodeDetectionResult(false, null, null, null, null, errorMessage);
    }

    /**
     * 创建失败结果（带尝试路径列表）
     *
     * @param errorMessage 错误消息
     * @param triedPaths 尝试过的路径列表
     * @return 失败的 NodeDetectionResult
     */
    public static NodeDetectionResult failure(String errorMessage, List<String> triedPaths) {
        return new NodeDetectionResult(false, null, null, null, triedPaths, errorMessage);
    }

    // ==================== Getter 方法 ====================

    /**
     * 获取是否找到 Node.js
     * @return true 如果找到
     */
    public boolean isFound() {
        return found;
    }

    /**
     * 获取 Node.js 可执行文件路径
     * @return Node.js 路径，如果未找到返回 null
     */
    public String getNodePath() {
        return nodePath;
    }

    /**
     * 获取 Node.js 版本
     * @return 版本号（如 "v18.16.0"），如果未找到返回 null
     */
    public String getNodeVersion() {
        return nodeVersion;
    }

    /**
     * 获取检测方法
     * @return 检测方法枚举值，如果未找到返回 null
     */
    public DetectionMethod getMethod() {
        return method;
    }

    /**
     * 获取尝试过的路径列表
     * @return 路径列表（不可修改）
     */
    public List<String> getTriedPaths() {
        return Collections.unmodifiableList(triedPaths);
    }

    /**
     * 获取错误消息
     * @return 错误消息，如果成功返回 null
     */
    public String getErrorMessage() {
        return errorMessage;
    }

    // ==================== 便捷方法 ====================

    /**
     * 添加尝试过的路径（内部使用）
     * @param path 尝试的路径
     */
    public void addTriedPath(String path) {
        if (path != null && !path.isEmpty()) {
            this.triedPaths.add(path);
        }
    }

    /**
     * 获取用户友好的错误描述（用于显示给用户）
     * @return 错误描述和解决建议
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

        // 根据平台提供安装建议
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
     * 获取检测方法的中文描述
     * @return 检测方法描述
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
