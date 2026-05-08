package com.github.claudecodegui.model;

/**
 * Represents a reusable session template configuration.
 * Contains the essential settings needed to recreate a session state.
 */
public class SessionTemplate {
    public String name;
    public String provider;
    public String model;
    public String permissionMode;
    public String reasoningEffort;
    public String cwd;
    public boolean psiContextEnabled;

    public SessionTemplate() {
        // Default constructor for JSON deserialization
    }

    public SessionTemplate(String name, String provider, String model, String permissionMode,
                          String reasoningEffort, String cwd, boolean psiContextEnabled) {
        this.name = name;
        this.provider = provider;
        this.model = model;
        this.permissionMode = permissionMode;
        this.reasoningEffort = reasoningEffort;
        this.cwd = cwd;
        this.psiContextEnabled = psiContextEnabled;
    }

    /**
     * Create a copy of this template.
     */
    public SessionTemplate copy() {
        return new SessionTemplate(name, provider, model, permissionMode,
                                  reasoningEffort, cwd, psiContextEnabled);
    }

    @Override
    public String toString() {
        return name != null ? name : "Unnamed Template";
    }
}