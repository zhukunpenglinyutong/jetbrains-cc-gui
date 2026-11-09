package com.github.claudecodegui.handler.history;

/**
 * Fork result codes for session forking. These codes are sent to the frontend
 * for internationalization as an errorCode on failure.
 *
 * @author Gadfly
 */
enum ForkResultCode {
    /**
     * Session ID format is invalid.
     */
    INVALID_SESSION_ID("INVALID_SESSION_ID"),

    /**
     * Forking is not implemented for this provider's storage format.
     */
    UNSUPPORTED_PROVIDER("UNSUPPORTED_PROVIDER"),

    /**
     * Session file not found in any project directory.
     */
    SESSION_NOT_FOUND("SESSION_NOT_FOUND"),

    /**
     * Session file disappeared after it was discovered.
     */
    FILE_NOT_EXIST("FILE_NOT_EXIST"),

    /**
     * The requested fork-point message uuid was not found in the session file.
     */
    FORK_POINT_NOT_FOUND("FORK_POINT_NOT_FOUND"),

    /**
     * The rows kept around the fork point cannot end on a resolved turn: the
     * clicked reply's own cycle still carries a tool call that never received
     * its result (an interrupted turn), so no fork can be published there.
     */
    UNRESOLVED_TOOL_USE("UNRESOLVED_TOOL_USE"),

    /**
     * Generic fork failure.
     */
    FORK_FAILED("FORK_FAILED");

    private final String code;

    ForkResultCode(String code) {
        this.code = code;
    }

    String getCode() {
        return this.code;
    }
}
