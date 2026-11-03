package com.github.claudecodegui.session;

import com.google.gson.JsonObject;

/**
 * Maps the daemon's answer to a steer request onto the receipt shown to the
 * webview.
 *
 * <p>Extracted from {@link ClaudeSession} so the decision can be tested without
 * an IntelliJ application: it is the only place that turns a timed-out daemon
 * call into something the UI acts on.
 */
public final class SteerReceiptMapper {

    /** Public receipt status: the CLI holds the steer. */
    public static final String ACCEPTED = "accepted";
    /** Public receipt status: the steer was not taken, the row goes back. */
    public static final String REJECTED = "rejected";
    /** Default reject reason when the daemon does not name one. */
    public static final String NO_ACTIVE_TURN = "no_active_turn";

    private SteerReceiptMapper() {
    }

    /**
     * Receipt status plus the reason, when there is one.
     */
    public static final class Outcome {
        private final String status;
        private final String reason;
        private final boolean unconfirmed;

        Outcome(String status, String reason, boolean unconfirmed) {
            this.status = status;
            this.reason = reason;
            this.unconfirmed = unconfirmed;
        }

        public String getStatus() {
            return status;
        }

        public String getReason() {
            return reason;
        }

        /**
         * Whether the daemon never answered, so delivery is still unknown.
         *
         * @return true when the outcome was inferred rather than reported
         */
        public boolean isUnconfirmed() {
            return unconfirmed;
        }
    }

    /**
     * Classify the daemon reply.
     *
     * <p>A timeout is reported as {@link #ACCEPTED} rather than a reject. The
     * request is not cancelled on the daemon side, so it can still enqueue the
     * steer; telling the webview it failed would put the row back in the queue
     * while the message is on its way and the same prompt would then run twice.
     * Accepted keeps the row hidden and the bubble pending, and a fold, an
     * undelivered receipt or the end of the turn settles it either way.
     *
     * @param result daemon reply, may be {@code null}
     * @return receipt to send to the webview
     */
    public static Outcome fromDaemonResult(JsonObject result) {
        if (boolField(result, "delivered")) {
            return new Outcome(ACCEPTED, null, false);
        }
        if (boolField(result, "unconfirmed")) {
            return new Outcome(ACCEPTED, null, true);
        }
        return new Outcome(REJECTED, stringField(result, "reason", NO_ACTIVE_TURN), false);
    }

    private static boolean boolField(JsonObject result, String name) {
        return result != null
                && result.has(name)
                && !result.get(name).isJsonNull()
                && result.get(name).getAsJsonPrimitive().isBoolean()
                && result.get(name).getAsBoolean();
    }

    private static String stringField(JsonObject result, String name, String fallback) {
        if (result == null || !result.has(name) || result.get(name).isJsonNull()) {
            return fallback;
        }
        String value = result.get(name).getAsString();
        return value == null || value.isEmpty() ? fallback : value;
    }
}
