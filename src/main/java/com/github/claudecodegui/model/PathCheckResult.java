package com.github.claudecodegui.model;

/**
 * 路径检查结果类
 * 用于表示路径验证操作的结果，包括路径长度检查、权限检查等
 */
public class PathCheckResult {

    /**
     * 结果级别枚举
     */
    public enum ResultLevel {
        /** 正常 */
        OK,
        /** 警告 */
        WARNING,
        /** 错误 */
        ERROR
    }

    private final ResultLevel level;
    private final String message;
    private final String path;
    private final int pathLength;

    /**
     * 私有构造函数
     */
    private PathCheckResult(ResultLevel level, String message, String path, int pathLength) {
        this.level = level;
        this.message = message;
        this.path = path;
        this.pathLength = pathLength;
    }

    // ==================== 工厂方法 ====================

    /**
     * 创建 OK 结果
     *
     * @return OK 状态的 PathCheckResult
     */
    public static PathCheckResult ok() {
        return new PathCheckResult(ResultLevel.OK, null, null, 0);
    }

    /**
     * 创建 OK 结果（带路径信息）
     *
     * @param path 检查的路径
     * @param pathLength 路径长度
     * @return OK 状态的 PathCheckResult
     */
    public static PathCheckResult ok(String path, int pathLength) {
        return new PathCheckResult(ResultLevel.OK, null, path, pathLength);
    }

    /**
     * 创建警告结果
     *
     * @param message 警告消息
     * @return WARNING 状态的 PathCheckResult
     */
    public static PathCheckResult warning(String message) {
        return new PathCheckResult(ResultLevel.WARNING, message, null, 0);
    }

    /**
     * 创建警告结果（带路径信息）
     *
     * @param message 警告消息
     * @param path 检查的路径
     * @param pathLength 路径长度
     * @return WARNING 状态的 PathCheckResult
     */
    public static PathCheckResult warning(String message, String path, int pathLength) {
        return new PathCheckResult(ResultLevel.WARNING, message, path, pathLength);
    }

    /**
     * 创建错误结果
     *
     * @param message 错误消息
     * @return ERROR 状态的 PathCheckResult
     */
    public static PathCheckResult error(String message) {
        return new PathCheckResult(ResultLevel.ERROR, message, null, 0);
    }

    /**
     * 创建错误结果（带路径信息）
     *
     * @param message 错误消息
     * @param path 检查的路径
     * @param pathLength 路径长度
     * @return ERROR 状态的 PathCheckResult
     */
    public static PathCheckResult error(String message, String path, int pathLength) {
        return new PathCheckResult(ResultLevel.ERROR, message, path, pathLength);
    }

    // ==================== Getter 方法 ====================

    /**
     * 获取结果级别
     * @return 结果级别枚举值
     */
    public ResultLevel getLevel() {
        return level;
    }

    /**
     * 获取消息
     * @return 消息内容，如果是 OK 状态可能为 null
     */
    public String getMessage() {
        return message;
    }

    /**
     * 获取检查的路径
     * @return 被检查的路径
     */
    public String getPath() {
        return path;
    }

    /**
     * 获取路径长度
     * @return 路径长度
     */
    public int getPathLength() {
        return pathLength;
    }

    // ==================== 便捷方法 ====================

    /**
     * 检查是否为 OK 状态
     * @return true 如果是 OK 状态
     */
    public boolean isOk() {
        return level == ResultLevel.OK;
    }

    /**
     * 检查是否为警告状态
     * @return true 如果是 WARNING 状态
     */
    public boolean isWarning() {
        return level == ResultLevel.WARNING;
    }

    /**
     * 检查是否为错误状态
     * @return true 如果是 ERROR 状态
     */
    public boolean isError() {
        return level == ResultLevel.ERROR;
    }

    /**
     * 检查是否有问题（警告或错误）
     * @return true 如果是 WARNING 或 ERROR 状态
     */
    public boolean hasIssue() {
        return level != ResultLevel.OK;
    }

    @Override
    public String toString() {
        return "PathCheckResult{" +
                "level=" + level +
                ", message='" + message + '\'' +
                ", path='" + path + '\'' +
                ", pathLength=" + pathLength +
                '}';
    }
}
