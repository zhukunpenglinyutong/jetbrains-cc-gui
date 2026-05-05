package com.github.claudecodegui.model;

/**
 * Enum representing the scope of prompt storage locations.
 * Determines where prompts are stored in the filesystem.
 */
public enum PromptScope {
    /**
     * Global scope - prompts stored in user's home directory.
     * Location: ~/.codemoss/prompt.json
     * These prompts are available across all projects for the user.
     */
    GLOBAL("global"),

    /**
     * Project scope - prompts stored in the project directory.
     * Location: &lt;project&gt;/codemoss/prompt.json
     * These prompts are specific to the current project.
     */
    PROJECT("project");

    private final String value;

    PromptScope(String value) {
        this.value = value;
    }

    /**
     * Get the string value representation of this scope.
     * @return The string value ("global" or "project")
     */
    public String getValue() {
        return value;
    }

    /**
     * Parse a string value into a PromptScope enum.
     * @param value The string value to parse (e.g., "global" or "project")
     * @return The corresponding PromptScope enum constant
     * @throws IllegalArgumentException if value is null or not a valid scope
     */
    public static PromptScope fromString(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Scope value cannot be null");
        }

        for (PromptScope scope : PromptScope.values()) {
            if (scope.value.equals(value)) {
                return scope;
            }
        }

        throw new IllegalArgumentException("Unknown scope: " + value);
    }

    @Override
    public String toString() {
        return value;
    }
}
