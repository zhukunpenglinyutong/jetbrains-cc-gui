package com.github.claudecodegui.model;

/**
 * Path check result class.
 * Represents the outcome of path validation operations, including path length checks, permission checks, etc.
 */
public class PathCheckResult {

    /**
     * Result severity level enum.
     */
    public enum ResultLevel {
        /** OK - no issues */
        OK,
        /** Warning */
        WARNING,
        /** Error */
        ERROR
    }

    private final ResultLevel level;
    private final String message;
    private final String path;
    private final int pathLength;

    /**
     * Private constructor.
     */
    private PathCheckResult(ResultLevel level, String message, String path, int pathLength) {
        this.level = level;
        this.message = message;
        this.path = path;
        this.pathLength = pathLength;
    }

    // ==================== Factory Methods ====================

    /**
     * Creates an OK result.
     *
     * @return a PathCheckResult with OK status
     */
    public static PathCheckResult ok() {
        return new PathCheckResult(ResultLevel.OK, null, null, 0);
    }

    /**
     * Creates an OK result with path information.
     *
     * @param path the checked path
     * @param pathLength the path length
     * @return a PathCheckResult with OK status
     */
    public static PathCheckResult ok(String path, int pathLength) {
        return new PathCheckResult(ResultLevel.OK, null, path, pathLength);
    }

    /**
     * Creates a warning result.
     *
     * @param message the warning message
     * @return a PathCheckResult with WARNING status
     */
    public static PathCheckResult warning(String message) {
        return new PathCheckResult(ResultLevel.WARNING, message, null, 0);
    }

    /**
     * Creates a warning result with path information.
     *
     * @param message the warning message
     * @param path the checked path
     * @param pathLength the path length
     * @return a PathCheckResult with WARNING status
     */
    public static PathCheckResult warning(String message, String path, int pathLength) {
        return new PathCheckResult(ResultLevel.WARNING, message, path, pathLength);
    }

    /**
     * Creates an error result.
     *
     * @param message the error message
     * @return a PathCheckResult with ERROR status
     */
    public static PathCheckResult error(String message) {
        return new PathCheckResult(ResultLevel.ERROR, message, null, 0);
    }

    /**
     * Creates an error result with path information.
     *
     * @param message the error message
     * @param path the checked path
     * @param pathLength the path length
     * @return a PathCheckResult with ERROR status
     */
    public static PathCheckResult error(String message, String path, int pathLength) {
        return new PathCheckResult(ResultLevel.ERROR, message, path, pathLength);
    }

    // ==================== Getters ====================

    /**
     * Gets the result level.
     * @return the result level enum value
     */
    public ResultLevel getLevel() {
        return level;
    }

    /**
     * Gets the message.
     * @return the message content, may be null if status is OK
     */
    public String getMessage() {
        return message;
    }

    /**
     * Gets the checked path.
     * @return the path that was checked
     */
    public String getPath() {
        return path;
    }

    /**
     * Gets the path length.
     * @return the path length
     */
    public int getPathLength() {
        return pathLength;
    }

    // ==================== Convenience Methods ====================

    /**
     * Checks whether the result is OK.
     * @return true if the status is OK
     */
    public boolean isOk() {
        return level == ResultLevel.OK;
    }

    /**
     * Checks whether the result is a warning.
     * @return true if the status is WARNING
     */
    public boolean isWarning() {
        return level == ResultLevel.WARNING;
    }

    /**
     * Checks whether the result is an error.
     * @return true if the status is ERROR
     */
    public boolean isError() {
        return level == ResultLevel.ERROR;
    }

    /**
     * Checks whether there is an issue (warning or error).
     * @return true if the status is WARNING or ERROR
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
