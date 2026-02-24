package com.github.claudecodegui.model;

/**
 * Enum representing strategies for handling conflicts during batch import operations.
 * Used when importing agents or prompts that have IDs matching existing items.
 */
public enum ConflictStrategy {
    /**
     * Skip importing items with conflicting IDs.
     * Existing items are preserved unchanged.
     * This is the safest strategy and recommended as default.
     */
    SKIP("skip"),

    /**
     * Overwrite existing items with imported data for conflicting IDs.
     * Use when you want to update existing configurations in bulk.
     */
    OVERWRITE("overwrite"),

    /**
     * Create duplicate items with new generated IDs for conflicts.
     * Useful when merging configurations from different sources.
     */
    DUPLICATE("duplicate");

    private final String value;

    ConflictStrategy(String value) {
        this.value = value;
    }

    public String getValue() {
        return value;
    }

    /**
     * Parse a string value into a ConflictStrategy enum.
     * @param value The string value to parse
     * @return The corresponding ConflictStrategy, or SKIP as default if value is null or invalid
     */
    public static ConflictStrategy fromValue(String value) {
        if (value == null || value.isEmpty()) {
            return SKIP;
        }

        for (ConflictStrategy strategy : ConflictStrategy.values()) {
            if (strategy.value.equalsIgnoreCase(value)) {
                return strategy;
            }
        }

        // Default to SKIP if invalid value provided
        return SKIP;
    }

    @Override
    public String toString() {
        return value;
    }
}
