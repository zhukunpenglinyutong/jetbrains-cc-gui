package com.github.claudecodegui.handler.history;

/**
 * Session entrypoint identifiers for Claude Code sessions.
 * Used to distinguish sessions created from different environments.
 *
 * @author Gadfly
 */
public enum SessionEntrypoint {
    /**
     * Session created by Claude Code CLI.
     */
    CLI("cli"),

    /**
     * Session created by Claude Code SDK (Agent SDK via this plugin).
     */
    SDK_CLI("sdk-cli"),

    /**
     * Session created by Claude for VS Code extension.
     */
    CLAUDE_VSCODE("claude-vscode"),

    /**
     * Session created by remote Claude Code instance.
     */
    REMOTE("remote"),

    /**
     * Unknown or missing entrypoint.
     */
    UNKNOWN(null);

    private final String value;

    SessionEntrypoint(String value) {
        this.value = value;
    }

    /**
     * Get the string value of this entrypoint.
     *
     * @return entrypoint value, or null for UNKNOWN
     */
    public String getValue() {
        return this.value;
    }

    /**
     * Returns whether this entrypoint can be rewritten into a CLI session.
     *
     * <p>The CLI only hides {@code sdk-cli}, {@code sdk-ts}, and {@code sdk-py} sessions
     * from its {@code /resume} list. Converting {@code claude-vscode} sessions rewrites
     * files owned by the VS Code extension without any visible benefit, as the CLI does
     * not hide them anyway.
     *
     * @return true when conversion to CLI is supported
     */
    public boolean isConvertibleToCli() {
        return this == SDK_CLI;
    }

    /**
     * Parse entrypoint string to enum.
     *
     * @param value entrypoint string value
     * @return corresponding enum value, or UNKNOWN if not recognized
     */
    public static SessionEntrypoint fromValue(String value) {
        if (value == null) {
            return UNKNOWN;
        }
        for (SessionEntrypoint ep : values()) {
            if (value.equals(ep.value)) {
                return ep;
            }
        }
        return UNKNOWN;
    }
}
