package com.github.claudecodegui.session;


import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Session state management.
 * Maintains all state information for a conversation session.
 */
public class SessionState {

    /**
     * Canonical whitelist of valid permission modes.
     * Shared across SessionHandler (payload validation) and ClaudeSession (mode resolution).
     */
    public static final Set<String> VALID_PERMISSION_MODES;
    public static final Set<String> VALID_CLAUDE_INVOCATION_MODES;
    public static final Set<String> VALID_PROVIDERS;
    static {
        Set<String> modes = new HashSet<>();
        modes.add("default");
        modes.add("plan");
        modes.add("acceptEdits");
        modes.add("autoEdit");
        modes.add("bypassPermissions");
        VALID_PERMISSION_MODES = Collections.unmodifiableSet(modes);

        Set<String> invocationModes = new HashSet<>();
        invocationModes.add("sdk");
        invocationModes.add("cli");
        VALID_CLAUDE_INVOCATION_MODES = Collections.unmodifiableSet(invocationModes);

        Set<String> providers = new HashSet<>();
        providers.add("claude");
        providers.add("codex");
        VALID_PROVIDERS = Collections.unmodifiableSet(providers);
    }

    /**
     * Check whether the given mode string is a recognized permission mode.
     */
    public static boolean isValidPermissionMode(String mode) {
        return mode != null && VALID_PERMISSION_MODES.contains(mode.trim());
    }

    public static boolean isValidClaudeInvocationMode(String mode) {
        return mode != null && VALID_CLAUDE_INVOCATION_MODES.contains(mode.trim());
    }

    // Session identifiers
    private String sessionId;
    private String channelId;
    private volatile String runtimeSessionEpoch = UUID.randomUUID().toString();

    // Session state — accessed only on EDT / single handler thread, no volatile needed.
    private boolean busy = false;
    private boolean loading = false;
    private String error = null;
    private ClaudeSession.SessionCallback.QueueDisplayState queueDisplayState =
            ClaudeSession.SessionCallback.QueueDisplayState.NONE;
    private int queueAheadCount = 0;

    // Message history
    private final List<ClaudeSession.Message> messages = new ArrayList<>();

    // Session metadata — cwd is written in handler thread before send(), read inside send();
    // the happens-before from CompletableFuture.runAsync guarantees visibility, so volatile is not required.
    private String summary = null;
    private long lastModifiedTime = System.currentTimeMillis();
    private String cwd = null;

    // Configuration fields below are volatile because set_mode / set_model / set_provider
    // and send_message may execute on different async handler threads with no other
    // happens-before guarantee between them.
    private volatile String permissionMode = "acceptEdits";
    private volatile String model = "claude-sonnet-4-6";
    private volatile String provider = "claude";
    private volatile String claudeInvocationMode = null;
    // Reasoning effort (thinking depth)
    private volatile String reasoningEffort = "high";

    // Slash commands — volatile for cross-thread visibility (same reason as permissionMode/model/provider)
    private volatile List<String> slashCommands = new ArrayList<>();

    // PSI context collection toggle
    private boolean psiContextEnabled = true;
    private final AtomicLong pendingSendInvalidationEpoch = new AtomicLong(0);

    // Getters
    public String getSessionId() {
        return sessionId;
    }

    public String getChannelId() {
        return channelId;
    }

    public boolean isBusy() {
        return busy;
    }

    public boolean isLoading() {
        return loading;
    }

    public String getError() {
        return error;
    }

    public ClaudeSession.SessionCallback.QueueDisplayState getQueueDisplayState() {
        return queueDisplayState;
    }

    public int getQueueAheadCount() {
        return queueAheadCount;
    }

    public List<ClaudeSession.Message> getMessages() {
        return new ArrayList<>(messages);
    }

    public List<ClaudeSession.Message> getMessagesReference() {
        return messages;
    }

    public String getSummary() {
        return summary;
    }

    public long getLastModifiedTime() {
        return lastModifiedTime;
    }

    public String getCwd() {
        return cwd;
    }

    public String getPermissionMode() {
        return permissionMode;
    }

    public String getModel() {
        return model;
    }

    public String getProvider() {
        return provider;
    }

    public String getClaudeInvocationMode() {
        return claudeInvocationMode;
    }

    public String getReasoningEffort() {
        return reasoningEffort;
    }

    public String getRuntimeSessionEpoch() {
        return runtimeSessionEpoch;
    }

    public List<String> getSlashCommands() {
        return new ArrayList<>(slashCommands);
    }



    public boolean isPsiContextEnabled() {
        return psiContextEnabled;
    }

    public long capturePendingSendInvalidationEpoch() {
        return pendingSendInvalidationEpoch.get();
    }

    public long invalidatePendingSendOperations() {
        return pendingSendInvalidationEpoch.incrementAndGet();
    }

    public boolean isPendingSendOperationCurrent(long epoch) {
        return pendingSendInvalidationEpoch.get() == epoch;
    }

    // Setters
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public void setBusy(boolean busy) {
        this.busy = busy;
    }

    public void setLoading(boolean loading) {
        this.loading = loading;
    }

    public void setError(String error) {
        this.error = error;
    }

    public void setQueueDisplayState(ClaudeSession.SessionCallback.QueueDisplayState queueDisplayState) {
        this.queueDisplayState = queueDisplayState != null
                ? queueDisplayState
                : ClaudeSession.SessionCallback.QueueDisplayState.NONE;
    }

    public void setQueueAheadCount(int queueAheadCount) {
        this.queueAheadCount = Math.max(0, queueAheadCount);
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public void setLastModifiedTime(long lastModifiedTime) {
        this.lastModifiedTime = lastModifiedTime;
    }

    public void setCwd(String cwd) {
        this.cwd = cwd;
    }

    public void setPermissionMode(String permissionMode) {
        if (permissionMode != null && !VALID_PERMISSION_MODES.contains(permissionMode.trim())) {
            // Reject unrecognized modes silently to prevent injection of arbitrary strings
            return;
        }
        this.permissionMode = permissionMode;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public void setProvider(String provider) {
        if (provider == null) {
            return;
        }
        String trimmed = provider.trim();
        if (VALID_PROVIDERS.contains(trimmed)) {
            this.provider = trimmed;
        }
    }

    public void setClaudeInvocationMode(String claudeInvocationMode) {
        if (claudeInvocationMode == null) {
            return;
        }
        String trimmed = claudeInvocationMode.trim();
        if (VALID_CLAUDE_INVOCATION_MODES.contains(trimmed)) {
            this.claudeInvocationMode = trimmed;
        }
    }

    public void setReasoningEffort(String reasoningEffort) {
        this.reasoningEffort = reasoningEffort;
    }

    public void setRuntimeSessionEpoch(String runtimeSessionEpoch) {
        if (runtimeSessionEpoch == null || runtimeSessionEpoch.trim().isEmpty()) {
            this.runtimeSessionEpoch = UUID.randomUUID().toString();
            return;
        }
        this.runtimeSessionEpoch = runtimeSessionEpoch;
    }

    public String rotateRuntimeSessionEpoch() {
        String newEpoch = UUID.randomUUID().toString();
        this.runtimeSessionEpoch = newEpoch;
        return newEpoch;
    }

    public void setSlashCommands(List<String> slashCommands) {
        this.slashCommands = new ArrayList<>(slashCommands);
    }



    public void setPsiContextEnabled(boolean psiContextEnabled) {
        this.psiContextEnabled = psiContextEnabled;
    }

    /**
     * Add a message to the history.
     */
    public void addMessage(ClaudeSession.Message message) {
        messages.add(message);
    }

    /**
     * Clear all messages.
     */
    public void clearMessages() {
        messages.clear();
    }

    /**
     * Update the last modified time to the current time.
     */
    public void updateLastModifiedTime() {
        this.lastModifiedTime = System.currentTimeMillis();
    }
}
