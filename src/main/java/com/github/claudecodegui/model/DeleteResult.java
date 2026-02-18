package com.github.claudecodegui.model;

/**
 * Delete operation result class.
 * Represents the outcome of a file or configuration deletion, including success/failure status and error details.
 */
public class DeleteResult {

    /**
     * Error type enum.
     */
    public enum ErrorType {
        /** No error */
        NONE,
        /** File is locked */
        FILE_LOCKED,
        /** Insufficient permissions */
        PERMISSION_DENIED,
        /** File not found */
        FILE_NOT_FOUND,
        /** I/O error */
        IO_ERROR,
        /** Resource is in use */
        IN_USE,
        /** Unknown error */
        UNKNOWN
    }

    private final boolean success;
    private final String errorMessage;
    private final ErrorType errorType;
    private final String affectedPath;
    private final String suggestion;

    /**
     * Private constructor.
     */
    private DeleteResult(boolean success, ErrorType errorType, String errorMessage, String affectedPath, String suggestion) {
        this.success = success;
        this.errorType = errorType;
        this.errorMessage = errorMessage;
        this.affectedPath = affectedPath;
        this.suggestion = suggestion;
    }

    // ==================== Factory Methods ====================

    /**
     * Creates a successful result.
     *
     * @return a successful DeleteResult
     */
    public static DeleteResult success() {
        return new DeleteResult(true, ErrorType.NONE, null, null, null);
    }

    /**
     * Creates a successful result with path information.
     *
     * @param deletedPath the path that was deleted
     * @return a successful DeleteResult
     */
    public static DeleteResult success(String deletedPath) {
        return new DeleteResult(true, ErrorType.NONE, null, deletedPath, null);
    }

    /**
     * Creates a failure result.
     *
     * @param errorType the type of error
     * @param errorMessage the error message
     * @return a failed DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage) {
        return new DeleteResult(false, errorType, errorMessage, null, null);
    }

    /**
     * Creates a failure result with path information.
     *
     * @param errorType the type of error
     * @param errorMessage the error message
     * @param affectedPath the path affected by the error
     * @return a failed DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage, String affectedPath) {
        return new DeleteResult(false, errorType, errorMessage, affectedPath, null);
    }

    /**
     * Creates a failure result with a suggestion for resolution.
     *
     * @param errorType the type of error
     * @param errorMessage the error message
     * @param affectedPath the path affected by the error
     * @param suggestion a suggested resolution
     * @return a failed DeleteResult
     */
    public static DeleteResult failure(ErrorType errorType, String errorMessage, String affectedPath, String suggestion) {
        return new DeleteResult(false, errorType, errorMessage, affectedPath, suggestion);
    }

    /**
     * Creates a failure result from an exception.
     *
     * @param e the exception that occurred
     * @param path the path related to the error
     * @return a failed DeleteResult
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

    // ==================== Getters ====================

    /**
     * Returns whether the operation was successful.
     * @return true if the operation succeeded
     */
    public boolean isSuccess() {
        return success;
    }

    /**
     * Gets the error message.
     * @return the error message, or null if the operation succeeded
     */
    public String getErrorMessage() {
        return errorMessage;
    }

    /**
     * Gets the error type.
     * @return the error type enum value
     */
    public ErrorType getErrorType() {
        return errorType;
    }

    /**
     * Gets the affected path.
     * @return the affected path, may be null
     */
    public String getAffectedPath() {
        return affectedPath;
    }

    /**
     * Gets the suggested resolution.
     * @return the suggestion, may be null
     */
    public String getSuggestion() {
        return suggestion;
    }

    /**
     * Gets a user-friendly error description.
     * @return a full description including error details and suggestions
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
