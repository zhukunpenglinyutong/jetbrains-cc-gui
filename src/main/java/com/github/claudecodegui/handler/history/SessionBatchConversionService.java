package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Server-side batch conversion of SDK-created sessions to CLI-recognizable ones.
 *
 * <p>The webview used to fire one {@code convert_to_cli_session} message per session, which
 * meant one bridge round-trip (and one webview callback) per row. The frontend now sends a
 * single {@code convert_all_to_cli_sessions} message and this service walks the history
 * index itself, reusing {@link SessionConversionService#convertSession} for the actual
 * file rewrite, then reports one aggregated result.
 *
 * <p>All environment access goes through constructor-injected suppliers so the class can be
 * exercised in a plain JUnit test without an IntelliJ application, a webview, or the real
 * {@code ~/.claude} directory.
 */
class SessionBatchConversionService {

    private static final Logger LOG = Logger.getInstance(SessionBatchConversionService.class);

    /** Batch finished; counts are meaningful. */
    static final String STATUS_COMPLETED = "completed";

    /** Another batch is still running; this invocation was rejected without touching any file. */
    static final String STATUS_ALREADY_RUNNING = "already_running";

    /** The history index could not be read, so no session was even considered. */
    static final String STATUS_FAILED = "failed";

    /**
     * One history row reduced to what the batch decision needs. {@code entrypoint} is kept
     * as the raw string so the filter decision is made from the index, exactly like the
     * per-row decision the single-session path makes.
     */
    record SessionCandidate(String sessionId, String entrypoint) { }

    /**
     * Single-session conversion entry point. Implemented by {@link SessionConversionService}
     * in production and by a scripted fake (or a temp-dir-backed real service) in tests.
     */
    interface SingleSessionConverter {
        /**
         * @param sessionId session to convert.
         * @param projectPath project path hint, may be null.
         * @return null on success, otherwise the reason code.
         */
        ConversionResultCode convert(String sessionId, String projectPath);
    }

    private final Supplier<List<SessionCandidate>> candidatesSupplier;
    private final Supplier<String> activeSessionIdSupplier;
    private final Supplier<String> projectPathSupplier;
    private final SingleSessionConverter converter;
    private final Consumer<JsonObject> resultSink;
    private final Executor backgroundExecutor;

    /**
     * One batch at a time. A second click must not start a second pass: both passes would
     * fight over the same file locks and could interleave temp-file swaps on the same jsonl.
     */
    private final AtomicBoolean running = new AtomicBoolean(false);

    SessionBatchConversionService(HandlerContext context) {
        this(
                () -> readProjectSessionCandidates(context),
                () -> readActiveSessionId(context),
                () -> context.resolveEffectiveWorkingDirectory(),
                new SessionConversionService(context)::convertSession,
                result -> sendBatchResult(context, result),
                ApplicationManager.getApplication()::executeOnPooledThread
        );
    }

    SessionBatchConversionService(
            Supplier<List<SessionCandidate>> candidatesSupplier,
            Supplier<String> activeSessionIdSupplier,
            Supplier<String> projectPathSupplier,
            SingleSessionConverter converter,
            Consumer<JsonObject> resultSink,
            Executor backgroundExecutor
    ) {
        this.candidatesSupplier = candidatesSupplier;
        this.activeSessionIdSupplier = activeSessionIdSupplier;
        this.projectPathSupplier = projectPathSupplier;
        this.converter = converter;
        this.resultSink = resultSink;
        this.backgroundExecutor = backgroundExecutor;
    }

    /**
     * Entry point for the {@code convert_all_to_cli_sessions} bridge message.
     *
     * <p>Returns immediately; the work happens on a pooled thread and the aggregated result
     * is pushed to the webview through {@code window.onBatchConversionResult}.
     */
    void convertAll() {
        if (!this.running.compareAndSet(false, true)) {
            LOG.info("[SessionBatchConversion] Rejected: a batch conversion is already running");
            this.resultSink.accept(alreadyRunningResult());
            return;
        }

        try {
            this.backgroundExecutor.execute(() -> {
                try {
                    this.resultSink.accept(this.runBatch());
                } catch (Exception e) {
                    LOG.error("[SessionBatchConversion] Batch conversion failed: " + e.getMessage(), e);
                    this.resultSink.accept(failedResult(e));
                } finally {
                    this.running.set(false);
                }
            });
        } catch (RuntimeException rejected) {
            // The executor refused the task outright (IDE shutting down). Release the guard,
            // otherwise every later batch would be rejected as "already running" forever.
            LOG.warn("[SessionBatchConversion] Batch not scheduled: " + rejected.getMessage());
            this.running.set(false);
        }
    }

    /**
     * Convert every convertible session of the current project and aggregate the outcomes.
     *
     * <p>Runs on the calling thread; the caller owns the threading and the reply.
     *
     * @return the aggregated result payload.
     */
    JsonObject runBatch() {
        List<SessionCandidate> candidates;
        String activeSessionId;
        String projectPath;
        try {
            candidates = this.candidatesSupplier.get();
            activeSessionId = this.activeSessionIdSupplier.get();
            projectPath = this.projectPathSupplier.get();
        } catch (Exception e) {
            LOG.warn("[SessionBatchConversion] Cannot read history index: " + e.getMessage());
            return failedResult(e);
        }

        List<String> skippedSessionIds = new ArrayList<>();
        List<String> failedSessionIds = new ArrayList<>();
        JsonObject errorCodes = new JsonObject();
        int converted = 0;
        int skipped = 0;
        int failed = 0;
        int eligible = 0;

        for (SessionCandidate candidate : candidates) {
            String sessionId = candidate.sessionId();
            if (!SessionEntrypoint.fromValue(candidate.entrypoint()).isConvertibleToCli()) {
                // Native CLI and unknown-entrypoint sessions are not this command's business:
                // they are absent from the batch rather than reported as a problem.
                continue;
            }
            eligible++;

            if (!HistoryDeleteService.isValidSessionId(sessionId)) {
                skipped++;
                skippedSessionIds.add(String.valueOf(sessionId));
                continue;
            }

            // The live session is re-checked here, not just in the client: the SDK keeps
            // appending to that jsonl, so replacing the file under it would drop new messages.
            if (sessionId.equals(activeSessionId)) {
                LOG.info("[SessionBatchConversion] Skipping active session: " + sessionId);
                skipped++;
                skippedSessionIds.add(sessionId);
                continue;
            }

            ConversionResultCode resultCode;
            try {
                resultCode = this.converter.convert(sessionId, projectPath);
            } catch (Exception e) {
                LOG.warn("[SessionBatchConversion] Conversion threw for " + sessionId + ": " + e.getMessage());
                resultCode = ConversionResultCode.CONVERSION_FAILED;
            }

            if (resultCode == null) {
                converted++;
            } else {
                failed++;
                failedSessionIds.add(sessionId);
                errorCodes.addProperty(sessionId, resultCode.getCode());
            }
        }

        LOG.info("[SessionBatchConversion] Finished: converted=" + converted
                + ", skipped=" + skipped + ", failed=" + failed + " (eligible=" + eligible + ")");

        JsonObject result = new JsonObject();
        result.addProperty("status", STATUS_COMPLETED);
        addCounts(result, eligible, converted, skipped, failed);
        result.add("skippedSessionIds", toJsonArray(skippedSessionIds));
        result.add("failedSessionIds", toJsonArray(failedSessionIds));
        result.add("errorCodes", errorCodes);
        return result;
    }

    private static void addCounts(JsonObject result, int total, int converted, int skipped, int failed) {
        result.addProperty("total", total);
        result.addProperty("converted", converted);
        result.addProperty("skipped", skipped);
        result.addProperty("failed", failed);
        result.add("skippedSessionIds", new JsonArray());
        result.add("failedSessionIds", new JsonArray());
        result.add("errorCodes", new JsonObject());
    }

    private static JsonArray toJsonArray(List<String> values) {
        JsonArray array = new JsonArray();
        for (String value : values) {
            array.add(value);
        }
        return array;
    }

    private static JsonObject alreadyRunningResult() {
        JsonObject result = new JsonObject();
        result.addProperty("status", STATUS_ALREADY_RUNNING);
        addCounts(result, 0, 0, 0, 0);
        return result;
    }

    private static JsonObject failedResult(Exception e) {
        JsonObject result = new JsonObject();
        result.addProperty("status", STATUS_FAILED);
        addCounts(result, 0, 0, 0, 0);
        result.addProperty("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
        return result;
    }

    /**
     * Read the current project's history index and reduce every row to id + entrypoint.
     *
     * @param context handler context supplying the project and the effective working directory.
     * @return candidates, never null.
     */
    private static List<SessionCandidate> readProjectSessionCandidates(HandlerContext context) {
        List<SessionCandidate> candidates = new ArrayList<>();
        String projectPath = context.resolveEffectiveWorkingDirectory();
        if (projectPath == null || projectPath.isEmpty()) {
            LOG.warn("[SessionBatchConversion] No project path, nothing to convert");
            return candidates;
        }

        String historyJson = new ClaudeHistoryReader().getProjectDataAsJson(projectPath);
        JsonObject root = new Gson().fromJson(historyJson, JsonObject.class);
        if (root == null || !root.has("sessions") || !root.get("sessions").isJsonArray()) {
            LOG.warn("[SessionBatchConversion] History index has no sessions array");
            return candidates;
        }

        for (JsonElement element : root.getAsJsonArray("sessions")) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject session = element.getAsJsonObject();
            JsonElement id = session.get("sessionId");
            if (id == null || !id.isJsonPrimitive()) {
                continue;
            }
            // The index stores "" for "extraction ran but found nothing"; that is not a
            // convertible entrypoint and SessionEntrypoint maps it to UNKNOWN.
            JsonElement entrypoint = session.get("entrypoint");
            String entrypointValue = entrypoint != null && entrypoint.isJsonPrimitive()
                    ? entrypoint.getAsString() : null;
            candidates.add(new SessionCandidate(id.getAsString(), entrypointValue));
        }
        return candidates;
    }

    private static String readActiveSessionId(HandlerContext context) {
        try {
            var session = context.getSession();
            return session != null ? session.getSessionId() : null;
        } catch (Exception e) {
            LOG.warn("[SessionBatchConversion] Failed to resolve active session: " + e.getMessage());
            return null;
        }
    }

    /**
     * Push the aggregated result to the webview, mirroring the single-session reply shape:
     * the payload is serialized, then escaped for a JS string literal, then guarded so a
     * webview that has not registered the callback yet is not an error.
     */
    private static void sendBatchResult(HandlerContext context, JsonObject result) {
        var project = context.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }
        String escapedJson = context.escapeJs(new Gson().toJson(result));
        String jsCode = "if (window.onBatchConversionResult) { window.onBatchConversionResult('" + escapedJson + "'); }";
        context.executeJavaScriptQueued(jsCode);
    }
}
