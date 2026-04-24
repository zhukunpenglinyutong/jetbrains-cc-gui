package com.github.claudecodegui.model;

/**
 * Model information for display in model selection dialogs.
 */
public class ModelInfo {
    private final String id;
    private final String label;
    private final String description;

    public ModelInfo(String id, String label, String description) {
        this.id = id;
        this.label = label;
        this.description = description;
    }

    public String getId() {
        return id;
    }

    public String getLabel() {
        return label;
    }

    public String getDescription() {
        return description;
    }

    @Override
    public String toString() {
        return label;
    }

    /**
     * Create a display string with description.
     */
    public String toDisplayString() {
        if (description != null && !description.isEmpty()) {
            return label + " (" + description + ")";
        }
        return label;
    }
}
