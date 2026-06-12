package com.github.claudecodegui.handler.history;

/**
 * Conversion result codes for SDK-to-CLI session conversion.
 * These codes are sent to the frontend for internationalization, either as
 * an errorCode (failure) or an infoCode (success with extra context).
 *
 * @author Gadfly
 */
enum ConversionResultCode {
    /**
     * Session ID format is invalid.
     */
    INVALID_SESSION_ID("INVALID_SESSION_ID"),

    /**
     * Session is currently active in this window; converting it would race
     * with the SDK process still appending to the jsonl file.
     */
    SESSION_ACTIVE("SESSION_ACTIVE"),

    /**
     * Session file not found in any project directory.
     */
    SESSION_NOT_FOUND("SESSION_NOT_FOUND"),

    /**
     * Session file disappeared after it was discovered.
     */
    FILE_NOT_EXIST("FILE_NOT_EXIST"),

    /**
     * Session is currently being accessed by another process.
     */
    FILE_LOCKED("FILE_LOCKED"),

    /**
     * Session is not an SDK-created session (entrypoint is not sdk-cli).
     */
    NOT_SDK_SESSION("NOT_SDK_SESSION"),

    /**
     * Session is already a CLI session.
     */
    ALREADY_CLI_SESSION("ALREADY_CLI_SESSION"),

    /**
     * Generic conversion failure.
     */
    CONVERSION_FAILED("CONVERSION_FAILED");

    private final String code;

    ConversionResultCode(String code) {
        this.code = code;
    }

    String getCode() {
        return this.code;
    }
}
