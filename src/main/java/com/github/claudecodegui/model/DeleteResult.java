package com.github.claudecodegui.model;

/**
 * 删除操作结果类
 * 用于表示文件或配置删除操作的结果，支持成功/失败状态和错误详情
 */
public class DeleteResult {

    /**
     * 错误类型枚举
     */
    public enum ErrorType {
        /** 无错误 */
        NONE,
        /** 文件被锁定 */
        FILE_LOCKED,
        /** 权限不足 */
        PERMISSION_DENIED,
        /** 文件未找到 */
        FILE_NOT_FOUND,
        /** IO 错误 */
        IO_ERROR,
        /** 资源正在使用中 */
        IN_USE,
        /** 未知错误 */
        UNKNOWN
    }

    private final boolean success;
    private final String errorMessage;
    private final ErrorType errorType;
    private final String affectedPath;
    private final String suggestion;

    /**
     * 私有构造函数
     */
    private DeleteResult(boolean success, ErrorType errorType, String errorMessage, String affectedPath, String suggestion) {
        this.success = success;
        this.errorType = errorType;
        this.errorMessage = errorMessage;
        this.affectedPath = affectedPath;
        this.suggestion = suggestion;
    }

    // ==================== 工厂方法 ====================

    /**
     * 创建成功结果
     *
     * @return 成功的 DeleteResult
     */
    public static DeleteResult success() {
        return new DeleteResult(true, ErrorType.NONE, null, null, null);
    }

    /**
     * 创建成功结果（带路径信息）
     *
     * @param deletedPath 已删除的路径
     * @return 成功的 DeleteResult
     */
    public static DeleteResult success(String deletedPath) {
        return new DeleteResult(true, ErrorType.NONE, null, deletedPath, null);
    }

    /**
     * 创建失败结果
     *
     * @param errorType 错误类型
     * @param errorMessage 错误消息
     * @return 失败的 DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage) {
        return new DeleteResult(false, errorType, errorMessage, null, null);
    }

    /**
     * 创建失败结果（带路径信息）
     *
     * @param errorType 错误类型
     * @param errorMessage 错误消息
     * @param affectedPath 受影响的路径
     * @return 失败的 DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage, String affectedPath) {
        return new DeleteResult(false, errorType, errorMessage, affectedPath, null);
    }

    /**
     * 创建失败结果（带建议）
     *
     * @param errorType 错误类型
     * @param errorMessage 错误消息
     * @param affectedPath 受影响的路径
     * @param suggestion 解决建议
     * @return 失败的 DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage, String affectedPath, String suggestion) {
        return new DeleteResult(false, errorType, errorMessage, affectedPath, suggestion);
    }

    /**
     * 根据异常创建失败结果
     *
     * @param e 异常对象
     * @param path 相关路径
     * @return 失败的 DeleteResult
     */
    public static DeleteResult fromException(Exception e, String path) {
        ErrorType type = ErrorType.UNKNOWN;
        String message = e.getMessage();
        String suggestion = null;

        if (e instanceof java.io.FileNotFoundException) {
            type = ErrorType.FILE_NOT_FOUND;
            suggestion = "请检查文件是否存在";
        } else if (e instanceof java.nio.file.AccessDeniedException ||
                   (message != null && message.toLowerCase().contains("access denied"))) {
            type = ErrorType.PERMISSION_DENIED;
            suggestion = "请检查文件权限，或以管理员身份运行";
        } else if (message != null && (message.toLowerCase().contains("locked") ||
                   message.toLowerCase().contains("being used"))) {
            type = ErrorType.FILE_LOCKED;
            suggestion = "请关闭可能占用文件的程序后重试";
        } else if (e instanceof java.io.IOException) {
            type = ErrorType.IO_ERROR;
            suggestion = "请检查磁盘空间和文件系统状态";
        }

        return new DeleteResult(false, type, message, path, suggestion);
    }

    // ==================== Getter 方法 ====================

    /**
     * 获取操作是否成功
     * @return true 如果操作成功
     */
    public boolean isSuccess() {
        return success;
    }

    /**
     * 获取错误消息
     * @return 错误消息，如果操作成功返回 null
     */
    public String getErrorMessage() {
        return errorMessage;
    }

    /**
     * 获取错误类型
     * @return 错误类型枚举值
     */
    public ErrorType getErrorType() {
        return errorType;
    }

    /**
     * 获取受影响的路径
     * @return 受影响的路径，可能为 null
     */
    public String getAffectedPath() {
        return affectedPath;
    }

    /**
     * 获取解决建议
     * @return 解决建议，可能为 null
     */
    public String getSuggestion() {
        return suggestion;
    }

    /**
     * 获取用户友好的错误描述
     * @return 包含错误信息和建议的完整描述
     */
    public String getUserFriendlyMessage() {
        if (success) {
            return "操作成功";
        }

        StringBuilder sb = new StringBuilder();
        sb.append("操作失败");

        if (errorMessage != null && !errorMessage.isEmpty()) {
            sb.append("：").append(errorMessage);
        }

        if (affectedPath != null && !affectedPath.isEmpty()) {
            sb.append("\n文件：").append(affectedPath);
        }

        if (suggestion != null && !suggestion.isEmpty()) {
            sb.append("\n建议：").append(suggestion);
        }

        return sb.toString();
    }

    @Override
    public String toString() {
        return "DeleteResult{" +
                "success=" + success +
                ", errorType=" + errorType +
                ", errorMessage='" + errorMessage + '\'' +
                ", affectedPath='" + affectedPath + '\'' +
                ", suggestion='" + suggestion + '\'' +
                '}';
    }
}
