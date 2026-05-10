package com.github.claudecodegui.model;

/**
 * Represents a reusable session template configuration.
 * Contains the essential settings needed to recreate a session state.
 */
public class SessionTemplate {
    private String name;
    private String provider;
    private String model;
    private String permissionMode;
    private String reasoningEffort;
    private String cwd;
    private boolean psiContextEnabled;

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

    public String getName() {
        return name;
    }

    public String getProvider() {
        return provider;
    }

    public String getModel() {
        return model;
    }

    public String getPermissionMode() {
        return permissionMode;
    }

    public String getReasoningEffort() {
        return reasoningEffort;
    }

    public String getCwd() {
        return cwd;
    }

    public boolean isPsiContextEnabled() {
        return psiContextEnabled;
    }

    @Override
    public String toString() {
        return name != null ? name : "Unnamed Template";
    }
}
