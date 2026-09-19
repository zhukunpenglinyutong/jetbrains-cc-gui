package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.Alarm;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.function.LongConsumer;

/**
 * Coalesces streaming message updates before pushing them to the webview.
 */
public class StreamMessageCoalescer {

    private static final Logger LOG = Logger.getInstance(StreamMessageCoalescer.class);
    private static final int UPDATE_INTERVAL_MS = 50;
    private static final int LARGE_UPDATE_PAYLOAD_CHARS = 150_000;
    private static final long SLOW_PAYLOAD_BUILD_MS = 25L;
    private static final int LARGE_PAYLOAD_THRESHOLD = 100_000;
    private static final int MEDIUM_INTERVAL_MS = 500;
    private static final int LARGE_INTERVAL_MS = 2_000;
    private static final int XLARGE_INTERVAL_MS = 5_000;
    private static final int LONG_CONVERSATION_THRESHOLD = 300;
    private static final int LONG_CONVERSATION_TAIL_SIZE = 64;
    private static final int STREAMING_MIN_INTERVAL_MS = 150;
    private static final int HEARTBEAT_INTERVAL_MS = 10_000;

    private final Object lock = new Object();
    private final Alarm updateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private final Alarm heartbeatAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private final ExecutorService snapshotExecutor;
    private final JsCallbackTarget callbackTarget;
    private volatile boolean streamActive;
    private volatile boolean disposed;
    private volatile boolean updateScheduled;
    private volatile long lastUpdateAtMs;
    private volatile long updateSequence;
    private volatile int lastPayloadChars;
    private volatile long lastPushedSequence;
    private boolean snapshotPending;
    /** The latest live list, used only while the caller still owns its state lock. */
    private List<ClaudeSession.Message> latestLiveMessages;
    /** An immutable-in-practice copy captured before asynchronous serialization. */
    private List<ClaudeSession.Message> latestSourceMessages;
    private List<ClaudeSession.Message> lastSnapshot;
    private List<ClaudeSession.Message> lastDeliveredSnapshot;
    private String latestStructuralSignature;
    // Gson keys use deep equality and mutable hashes. Cache by raw identity and
    // retain only the current list so old stream fragments cannot accumulate.
    private Map<JsonObject, String> structuralSignatureCache = new IdentityHashMap<>();
    private boolean snapshotBuildRunning;
    private List<ClaudeSession.Message> requestedSnapshot;
    private long requestedSequence;
    private long requestedDeliveryEpoch;
    private boolean requestedForceFull;
    private long deliveryEpoch;
    private LongConsumer requestedAfterFlush;

    /**
     * Callback interface to push data to the webview.
     */
    public interface JsCallbackTarget {
        /**
         * Enqueue a webview call and report whether the queue accepted it.
         *
         * @param functionName JavaScript function name
         * @param args escaped JavaScript arguments
         * @return {@code true} when the call was retained for delivery
         */
        boolean callJavaScript(String functionName, String... args);

        boolean isDisposed();

        /**
         * Report whether the destination can accept a queued call at this moment.
         *
         * @return {@code true} when the destination is available
         */
        default boolean isAvailable() {
            return !isDisposed();
        }

        HandlerContext getHandlerContext();
    }

    record MessageTransport(
            List<ClaudeSession.Message> messages,
            int baseIndex,
            boolean tailUpdate
    ) {
    }

    /**
     * Create a message coalescer for one chat window.
     *
     * @param callbackTarget destination for ordered webview events
     */
    public StreamMessageCoalescer(JsCallbackTarget callbackTarget) {
        this.callbackTarget = callbackTarget;
        this.snapshotExecutor = Executors.newSingleThreadExecutor(new SnapshotThreadFactory());
    }

    /**
     * Enqueue the newest message state for coalesced delivery.
     *
     * <p>Structural snapshots are copied synchronously while the provider handler
     * still owns the session-state lock. Only that stable copy is handed to the
     * asynchronous serializer; text-only streaming updates keep a live reference
     * until the final flush so they do not deep-copy a large transcript per delta.</p>
     */
    public void enqueue(List<ClaudeSession.Message> messages) {
        if (disposed || callbackTarget.isDisposed() || messages == null) {
            return;
        }
        // Delta-capable providers keep text flowing through the lightweight channel;
        // snapshots remain for structure and final reconciliation.
        //
        // Both the signature walk and the capture below run under the caller's message
        // lock, and copyMessagesForTransport already tolerates a null raw, so a failure
        // in either is a genuine bug rather than a race to retry around. Neither is
        // swallowed: a silently dropped snapshot leaves the UI stale with no signal at
        // all, which is strictly harder to diagnose than a thrown exception.
        String structuralSignature = getStructuralSignature(messages);
        // Read outside the lock: this calls into HandlerContext, and a stale
        // read only schedules (or skips) one push that the stream-end flush
        // reconciles. Keep foreign calls out of the critical section.
        boolean deltaChannelAvailable = hasDeltaChannel();
        boolean shouldSchedule;
        boolean active;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            latestLiveMessages = List.copyOf(messages);
            boolean structuralChanged = !Objects.equals(latestStructuralSignature, structuralSignature);
            latestStructuralSignature = structuralSignature;
            active = streamActive;
            snapshotPending = snapshotPending || !active || !deltaChannelAvailable || structuralChanged;
            shouldSchedule = !active || !deltaChannelAvailable || structuralChanged;
            if (shouldSchedule) {
                // This copy is deliberately made before the provider can mutate raw again.
                latestSourceMessages = copyMessagesForTransport(messages);
            }
        }
        if (active) {
            startHeartbeat();
        }
        if (shouldSchedule) {
            schedulePush();
        }
    }

    /**
     * Notify that a stream has started.
     */
    public void onStreamStart() {
        synchronized (lock) {
            streamActive = true;
            latestStructuralSignature = null;
        }
        startHeartbeat();
    }

    /**
     * Notify that a stream has ended. Only clears the streaming state here; the
     * deferred-reload drain must wait until the final snapshot has been accepted by
     * the webview queue, which the adapter guarantees via its stream-end callback.
     */
    public void onStreamEnd() {
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
            lastPayloadChars = 0;
        }
    }

    /**
     * Forget the previous webview delivery baseline without discarding session state.
     *
     * <p>The retained live/source state is marked pending so the next ready page can
     * receive a full snapshot instead of attempting to apply a tail against an empty
     * frontend transcript.</p>
     *
     * <p>A queued snapshot is dropped — the caller is about to replay a fresh one —
     * but its {@code afterFlush} is not. That callback carries the stream-end signal,
     * and dropping it would strand the frontend in the responding state until the
     * adapter's fallback alarm fires. Running it here is safe: the signal is
     * generation-guarded on the adapter side, and the frontend treats a stream end
     * with no active stream as the finalize-only case.</p>
     */
    public void resetDeliveryBaseline() {
        final LongConsumer orphanedCallback;
        final long orphanedSequence;
        synchronized (lock) {
            deliveryEpoch++;
            lastSnapshot = null;
            lastDeliveredSnapshot = null;
            lastPayloadChars = 0;
            latestStructuralSignature = null;
            requestedSnapshot = null;
            orphanedCallback = requestedAfterFlush;
            orphanedSequence = requestedSequence;
            requestedAfterFlush = null;
            requestedForceFull = false;
            snapshotPending = latestSourceMessages != null || latestLiveMessages != null;
        }
        // Outside the lock: the callback reaches into the adapter and the webview queue.
        runAfterFlush(orphanedCallback, orphanedSequence);
    }

    /**
     * Replay a complete snapshot to a newly ready webview page.
     *
     * <p>The list is used as-is, so callers must pass a stable copy such as
     * {@code session.getMessagesSnapshot()} — replaying never re-copies, which keeps
     * tab-activation replays off the EDT's critical path.</p>
     *
     * @param messages stable message snapshot for the current session
     */
    public void replayLatestSnapshot(List<ClaudeSession.Message> messages) {
        if (disposed || callbackTarget.isDisposed() || messages == null) {
            return;
        }
        final long sequence;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            latestLiveMessages = messages;
            latestSourceMessages = messages;
            latestStructuralSignature = null;
            snapshotPending = true;
            sequence = ++updateSequence;
        }
        requestSnapshotBuild(messages, sequence, null, true);
    }

    /**
     * Return whether a snapshot is queued or currently being serialized.
     *
     * <p>Deliberately reports only serialization work, not "state is outstanding":
     * callers use this to decide whether the final snapshot has reached the webview
     * queue yet. A snapshot parked because its destination vanished is recovered by
     * the page-ready replay or the next enqueue, so reporting it here would only make
     * the deferred-reload pollers spin on a condition they cannot resolve.</p>
     *
     * @return true when serialization work remains
     */
    public boolean isSnapshotBuildPending() {
        synchronized (lock) {
            return snapshotBuildRunning || requestedSnapshot != null;
        }
    }

    /**
     * Reset stream state when the active session changes.
     *
     * @return the sequence barrier for the frontend
     */
    public long resetStreamState() {
        updateAlarm.cancelAllRequests();
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
            updateScheduled = false;
            snapshotPending = false;
            latestSourceMessages = null;
            latestLiveMessages = null;
            lastSnapshot = null;
            lastDeliveredSnapshot = null;
            latestStructuralSignature = null;
            requestedSnapshot = null;
            requestedAfterFlush = null;
            requestedForceFull = false;
            lastUpdateAtMs = 0L;
            lastPayloadChars = 0;
            lastPushedSequence = ++updateSequence;
            deliveryEpoch++;
            return lastPushedSequence;
        }
    }

    /**
     * Return whether the current stream is active.
     *
     * @return true while a stream is active
     */
    public boolean isStreamActive() {
        return streamActive;
    }

    /**
     * Flush the latest messages immediately and optionally run a callback afterwards.
     *
     * @param afterFlush callback invoked after the full snapshot has been accepted by the webview queue
     */
    public void flush(LongConsumer afterFlush) {
        flush(null, afterFlush);
    }

    /**
     * Flush an explicitly supplied message list as a full snapshot.
     *
     * <p>Three sources feed the snapshot, each copied differently because only one
     * of them can still be mutated:</p>
     * <ul>
     *   <li><b>{@code messages} supplied by the caller</b> — a live list. The caller
     *       must hold {@code SessionState}'s message lock for the duration of this
     *       call, exactly as {@link #enqueue(List)} requires, because the deep copy
     *       below runs against it. {@link #copyMessagesForTransport(List)} treats a
     *       concurrent mutation as a bug rather than a race to retry around.</li>
     *   <li><b>{@code latestSourceMessages}</b> — already an independent deep copy
     *       captured under that lock by {@link #enqueue(List)} or
     *       {@link #replayLatestSnapshot(List)}. Reused as-is: copying it again
     *       would double the cost of every final flush on a long transcript. This is
     *       the newest structure the provider announced, so it is also the raw tree
     *       the frontend should reconcile against.</li>
     *   <li><b>{@code latestLiveMessages}</b> — a shallow list copy that still
     *       references live raws. Copied here, and the caller must hold the lock.</li>
     * </ul>
     * <p>When none of the three exists the previous snapshot is replayed, so a flush
     * with no state behind it is a no-op rather than a clear.</p>
     *
     * @param messages latest message list captured under the caller's state lock, or {@code null}
     * @param afterFlush callback invoked after the snapshot has been accepted
     */
    public void flush(List<ClaudeSession.Message> messages, LongConsumer afterFlush) {
        if (disposed) {
            runAfterFlush(afterFlush, -1L);
            return;
        }

        final List<ClaudeSession.Message> sourceMessages;
        final boolean sourceIsTransportCopy;
        final List<ClaudeSession.Message> previousSnapshot;
        final long sequence;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            snapshotPending = false;
            if (messages != null) {
                sourceMessages = List.copyOf(messages);
                sourceIsTransportCopy = false;
            } else if (latestSourceMessages != null) {
                // enqueue/replayLatestSnapshot already captured this list as an
                // independent deep copy under the state lock; copying it again would
                // double the cost of every final flush on a long transcript.
                sourceMessages = latestSourceMessages;
                sourceIsTransportCopy = true;
            } else {
                sourceMessages = latestLiveMessages;
                sourceIsTransportCopy = false;
            }
            previousSnapshot = lastSnapshot;
            sequence = ++updateSequence;
        }

        final List<ClaudeSession.Message> snapshot;
        if (sourceMessages == null) {
            snapshot = previousSnapshot;
        } else if (sourceIsTransportCopy) {
            snapshot = sourceMessages;
        } else {
            // A transport copy is already detached; only a live source is copied here,
            // and the caller holds the message lock that makes it safe. A failure is a
            // genuine bug, so it propagates rather than being swallowed — the caller
            // owns the recovery, and the stream-end fallback alarm is the backstop.
            snapshot = copyMessagesForTransport(sourceMessages);
        }

        if (snapshot == null) {
            runAfterFlush(afterFlush, sequence);
            return;
        }

        synchronized (lock) {
            latestSourceMessages = snapshot;
            snapshotPending = true;
        }
        requestSnapshotBuild(snapshot, sequence, afterFlush, true);
    }

    /**
     * Dispose internal resources.
     */
    public void dispose() {
        disposed = true;
        try {
            updateAlarm.cancelAllRequests();
            updateAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose stream message update alarm: " + e.getMessage());
        }
        try {
            heartbeatAlarm.cancelAllRequests();
            heartbeatAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose heartbeat alarm: " + e.getMessage());
        }
        snapshotExecutor.shutdownNow();
    }

    private int effectiveIntervalMs() {
        if (!streamActive) {
            return UPDATE_INTERVAL_MS;
        }
        int chars = lastPayloadChars;
        int interval;
        if (chars > 500_000) {
            interval = XLARGE_INTERVAL_MS;
        } else if (chars > 200_000) {
            interval = LARGE_INTERVAL_MS;
        } else if (chars > LARGE_PAYLOAD_THRESHOLD) {
            interval = MEDIUM_INTERVAL_MS;
        } else {
            return STREAMING_MIN_INTERVAL_MS;
        }
        if (LOG.isDebugEnabled()) {
            LOG.debug("[AdaptiveThrottle] payload=" + chars + " chars, interval=" + interval + "ms");
        }
        return interval;
    }

    private void schedulePush() {
        if (disposed || callbackTarget.isDisposed()) {
            return;
        }

        final int delayMs;
        synchronized (lock) {
            if (updateScheduled) {
                return;
            }
            int intervalMs = effectiveIntervalMs();
            long elapsed = System.currentTimeMillis() - lastUpdateAtMs;
            delayMs = (int) Math.max(0L, intervalMs - elapsed);
            updateScheduled = true;
            ++updateSequence;
        }

        updateAlarm.addRequest(() -> {
            final List<ClaudeSession.Message> sourceMessages;
            final List<ClaudeSession.Message> snapshot;
            final long sequence;
            synchronized (lock) {
                updateScheduled = false;
                snapshotPending = false;
                lastUpdateAtMs = System.currentTimeMillis();
                sourceMessages = latestSourceMessages;
                sequence = updateSequence;
            }
            snapshot = sourceMessages;

            if (disposed || callbackTarget.isDisposed()) {
                return;
            }
            if (snapshot != null) {
                requestSnapshotBuild(snapshot, sequence, null, false);
            }

            boolean hasPending;
            synchronized (lock) {
                hasPending = snapshotPending;
            }
            if (hasPending && !disposed && !callbackTarget.isDisposed()) {
                schedulePush();
            }
        }, delayMs);
    }

    private void requestSnapshotBuild(
            List<ClaudeSession.Message> messages,
            long sequence,
            LongConsumer afterFlush,
            boolean forceFull
    ) {
        boolean startWorker = false;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            requestedSnapshot = messages;
            requestedSequence = sequence;
            requestedDeliveryEpoch = deliveryEpoch;
            requestedForceFull = requestedForceFull || forceFull;
            requestedAfterFlush = chainCallbacks(requestedAfterFlush, afterFlush);
            if (!snapshotBuildRunning) {
                snapshotBuildRunning = true;
                startWorker = true;
            }
        }
        if (startWorker) {
            try {
                snapshotExecutor.execute(this::buildNextSnapshot);
            } catch (RuntimeException e) {
                final LongConsumer orphanedCallback;
                synchronized (lock) {
                    snapshotBuildRunning = false;
                    requestedSnapshot = null;
                    orphanedCallback = requestedAfterFlush;
                    requestedAfterFlush = null;
                    requestedForceFull = false;
                }
                LOG.warn("Failed to schedule message snapshot serialization: " + e.getMessage(), e);
                // Run the chained callbacks (which include afterFlush) so a
                // stream-end signal riding this flush is never silently lost.
                runAfterFlush(orphanedCallback, sequence);
            }
        }
    }

    private void buildNextSnapshot() {
        final List<ClaudeSession.Message> messages;
        final long sequence;
        final LongConsumer afterFlush;
        final boolean forceFull;
        final List<ClaudeSession.Message> deliveredSnapshot;
        final long snapshotDeliveryEpoch;
        synchronized (lock) {
            if (disposed || requestedSnapshot == null) {
                snapshotBuildRunning = false;
                return;
            }
            messages = requestedSnapshot;
            sequence = requestedSequence;
            afterFlush = requestedAfterFlush;
            forceFull = requestedForceFull;
            deliveredSnapshot = lastDeliveredSnapshot;
            snapshotDeliveryEpoch = requestedDeliveryEpoch;
            requestedSnapshot = null;
            requestedAfterFlush = null;
            requestedForceFull = false;
            lastSnapshot = messages;
        }

        boolean sent = false;
        boolean stale = false;
        try {
            MessageTransport transport = forceFull
                    ? new MessageTransport(messages, 0, false)
                    : selectMessageTransport(messages, deliveredSnapshot);
            long buildStartedAt = System.nanoTime();
            String messagesJson = MessageJsonConverter.convertMessagesToJson(transport.messages());
            int payloadChars = messagesJson.length();
            String escapedMessagesJson = JsUtils.escapeJs(messagesJson);
            long payloadBuildMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(
                    System.nanoTime() - buildStartedAt);
            if (isCurrentDeliveryEpoch(snapshotDeliveryEpoch)) {
                lastPayloadChars = payloadChars;
            }

            if (payloadChars >= LARGE_UPDATE_PAYLOAD_CHARS || payloadBuildMs >= SLOW_PAYLOAD_BUILD_MS) {
                LOG.info("[WebviewTransport] updateMessages payload chars=" + payloadChars
                        + ", messages=" + messages.size()
                        + ", transportedMessages=" + transport.messages().size()
                        + ", tailBaseIndex=" + transport.baseIndex()
                        + ", buildMs=" + payloadBuildMs
                        + ", sequence=" + sequence
                        + ", forceFull=" + forceFull);
            } else if (LOG.isDebugEnabled()) {
                LOG.debug("[WebviewTransport] updateMessages payload chars=" + payloadChars
                        + ", messages=" + messages.size()
                        + ", buildMs=" + payloadBuildMs
                        + ", sequence=" + sequence
                        + ", forceFull=" + forceFull);
            }

            final long pushSequence;
            synchronized (lock) {
                if (snapshotDeliveryEpoch != deliveryEpoch || sequence < lastPushedSequence) {
                    pushSequence = -1L;
                    stale = true;
                } else {
                    pushSequence = sequence;
                }
            }
            if (pushSequence >= 0L && !disposed && !callbackTarget.isDisposed()) {
                boolean accepted = callbackTarget.isAvailable();
                if (accepted) {
                    if (transport.tailUpdate()) {
                        accepted = callbackTarget.callJavaScript(
                                "updateMessageTail",
                                escapedMessagesJson,
                                String.valueOf(transport.baseIndex()),
                                String.valueOf(pushSequence));
                    } else {
                        accepted = callbackTarget.callJavaScript(
                                "updateMessages", escapedMessagesJson, String.valueOf(pushSequence));
                    }
                }
                if (accepted) {
                    synchronized (lock) {
                        if (snapshotDeliveryEpoch == deliveryEpoch && sequence >= lastPushedSequence) {
                            lastPushedSequence = sequence;
                            lastDeliveredSnapshot = messages;
                            if (latestSourceMessages == messages && requestedSnapshot == null) {
                                snapshotPending = false;
                            }
                        }
                    }
                    // The snapshot is delivered from here on. Mark it sent BEFORE the
                    // usage push: a failure in that foreign HandlerContext code must
                    // not drop this frame into the catch below, which would park an
                    // already-delivered snapshot's afterFlush (the stream-end signal)
                    // and force a needless full re-serialization.
                    sent = true;
                    String usageJson = MessageJsonConverter.buildUsageUpdateJson(
                            messages, callbackTarget.getHandlerContext());
                    if (usageJson != null) {
                        callbackTarget.callJavaScript("onUsageUpdate", JsUtils.escapeJs(usageJson));
                    }
                } else {
                    // The destination is unavailable (page not ready) or the bounded
                    // queue rejected the call. Retrying here would re-serialize the
                    // whole transcript against a destination already known to be
                    // closed; the queue retains its own pending events and re-drains
                    // on the frontend-ready transition, and a page replay re-requests
                    // a full snapshot. Park the state instead.
                    markSnapshotUndelivered(afterFlush, snapshotDeliveryEpoch);
                }
            } else if (!stale) {
                // Reachable only when the push was skipped because the target is
                // gone: pushSequence >= 0 and stale == false leave `disposed ||
                // callbackTarget.isDisposed()` as the only false condition above.
                // Both are monotonic, so this is genuinely a dead destination
                // rather than a race — run the callback, but do not park the
                // snapshot for a page that no longer exists.
                stale = true;
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to serialize or push message snapshot: " + e.getMessage(), e);
            // The failure may have happened before the push decision above, so this
            // re-derives staleness rather than reusing `stale`. A live destination
            // parks the snapshot for retry; a dead one only runs the callback.
            // A snapshot already marked sent was delivered — parking it would
            // chain its afterFlush into the next build and run it twice.
            boolean abandoned = disposed || callbackTarget.isDisposed()
                    || !isCurrentDeliveryEpoch(snapshotDeliveryEpoch);
            if (abandoned) {
                stale = true;
            } else if (!sent) {
                markSnapshotUndelivered(afterFlush, snapshotDeliveryEpoch);
            }
        }

        if (sent || stale) {
            runAfterFlush(afterFlush, sequence);
        }

        boolean continueWorker;
        synchronized (lock) {
            continueWorker = !disposed && requestedSnapshot != null;
            if (!continueWorker) {
                snapshotBuildRunning = false;
            }
        }
        if (continueWorker) {
            try {
                snapshotExecutor.execute(this::buildNextSnapshot);
            } catch (RuntimeException e) {
                final LongConsumer orphanedCallback;
                final long orphanedSequence;
                synchronized (lock) {
                    snapshotBuildRunning = false;
                    requestedSnapshot = null;
                    orphanedCallback = requestedAfterFlush;
                    orphanedSequence = requestedSequence;
                    requestedAfterFlush = null;
                    requestedForceFull = false;
                }
                LOG.warn("Failed to continue message snapshot serialization: " + e.getMessage(), e);
                runAfterFlush(orphanedCallback, orphanedSequence);
            }
        }
        if (!sent && afterFlush == null && LOG.isDebugEnabled()) {
            LOG.debug("Message snapshot was not dispatched, sequence=" + sequence);
        }
    }

    /**
     * Record that a built snapshot never reached the webview.
     *
     * <p>The snapshot is not retried from here. Instead the pending flag is restored
     * so the replay machinery knows state is outstanding, the next delivery is forced
     * to be a full baseline (a tail is meaningless to a page that missed its
     * baseline), and the caller's {@code afterFlush} is parked rather than dropped or
     * run early — it still has to observe the ordering contract that the stream-end
     * signal follows the final snapshot.</p>
     *
     * @param afterFlush callback riding this snapshot, or {@code null}
     * @param snapshotDeliveryEpoch delivery epoch the snapshot was built for
     */
    private void markSnapshotUndelivered(LongConsumer afterFlush, long snapshotDeliveryEpoch) {
        synchronized (lock) {
            if (disposed || snapshotDeliveryEpoch != deliveryEpoch) {
                return;
            }
            snapshotPending = true;
            requestedForceFull = true;
            if (afterFlush != null) {
                requestedAfterFlush = chainCallbacks(requestedAfterFlush, afterFlush);
            }
        }
    }

    /**
     * Combine two optional callbacks so both run, first-registered first.
     *
     * @param existing callback already parked, or {@code null}
     * @param incoming callback to append, or {@code null}
     * @return the combined callback, or {@code null} when neither is present
     */
    private static LongConsumer chainCallbacks(LongConsumer existing, LongConsumer incoming) {
        if (existing == null) {
            return incoming;
        }
        if (incoming == null) {
            return existing;
        }
        return completedSequence -> {
            existing.accept(completedSequence);
            incoming.accept(completedSequence);
        };
    }

    private boolean isCurrentDeliveryEpoch(long epoch) {
        synchronized (lock) {
            return !disposed && epoch == deliveryEpoch;
        }
    }

    private void runAfterFlush(LongConsumer afterFlush, long sequence) {
        if (afterFlush == null) {
            return;
        }
        try {
            afterFlush.accept(sequence);
        } catch (RuntimeException e) {
            LOG.warn("Snapshot completion callback failed: " + e.getMessage(), e);
        }
    }

    static MessageTransport selectMessageTransport(List<ClaudeSession.Message> messages,
                                                    List<ClaudeSession.Message> previousMessages) {
        boolean longConversation = messages.size() > LONG_CONVERSATION_THRESHOLD;
        int candidateBaseIndex = longConversation
                ? Math.max(0, messages.size() - LONG_CONVERSATION_TAIL_SIZE) : 0;
        boolean stablePrefix = previousMessages != null
                && messages.size() >= previousMessages.size()
                && hasSamePrefix(previousMessages, messages, candidateBaseIndex);
        boolean tailUpdate = longConversation && stablePrefix;
        int baseIndex = tailUpdate ? candidateBaseIndex : 0;
        List<ClaudeSession.Message> transportMessages = tailUpdate
                ? List.copyOf(messages.subList(baseIndex, messages.size())) : messages;
        return new MessageTransport(transportMessages, baseIndex, tailUpdate);
    }

    private static boolean hasSamePrefix(List<ClaudeSession.Message> previousMessages,
                                         List<ClaudeSession.Message> messages,
                                         int prefixLength) {
        if (previousMessages.size() < prefixLength) {
            return false;
        }
        for (int i = 0; i < prefixLength; i++) {
            if (!sameStableMessage(previousMessages.get(i), messages.get(i))) {
                return false;
            }
        }
        return true;
    }

    private static boolean sameStableMessage(ClaudeSession.Message previous,
                                             ClaudeSession.Message current) {
        return previous == current
                || previous.type == current.type
                && previous.timestamp == current.timestamp
                && Objects.equals(previous.content, current.content)
                && Objects.equals(
                        computeMessageStructuralSignature(previous.raw),
                        computeMessageStructuralSignature(current.raw));
    }

    /**
     * Deep-copy messages for asynchronous transport.
     *
     * <p>Every caller reaches this while holding {@code SessionState}'s message lock —
     * either directly ({@code enqueue}, {@code flush}, {@code getMessagesSnapshot}) or
     * by owning the list it passes in ({@code replayLatestSnapshot}). A concurrent
     * writer therefore cannot interleave, and a failure here is a genuine bug rather
     * than a race to retry around. Recovery belongs to the callers: they keep the
     * previous snapshot and let the next event or the stream-end flush rebuild it.</p>
     *
     * <p>Which lock is held matters less than that one is: the copy only has to be
     * ordered against writes to the lists and raw trees it walks. Callers locking a
     * <em>new</em> session's state while the coalescer still holds state retained
     * from a <em>previous</em> one are still correct, because a superseded session
     * has no live writer left — its provider callbacks were deactivated and the
     * daemon reader stopped with the channel.</p>
     */
    static List<ClaudeSession.Message> copyMessagesForTransport(List<ClaudeSession.Message> messages) {
        List<ClaudeSession.Message> copies = new ArrayList<>(messages.size());
        for (ClaudeSession.Message message : messages) {
            ClaudeSession.Message copy = new ClaudeSession.Message(message.type, message.content);
            copy.timestamp = message.timestamp;
            copy.raw = message.raw == null ? null : message.raw.deepCopy();
            copies.add(copy);
        }
        return List.copyOf(copies);
    }

    private synchronized String getStructuralSignature(List<ClaudeSession.Message> messages) {
        Map<JsonObject, String> currentCache = new IdentityHashMap<>();
        StringBuilder signature = new StringBuilder();
        for (int i = 0; i < messages.size(); i++) {
            ClaudeSession.Message message = messages.get(i);
            JsonObject raw = message.raw;
            String blockSignature = raw == null ? "" : structuralSignatureCache.get(raw);
            if (blockSignature == null) {
                blockSignature = computeMessageStructuralSignature(raw);
            }
            if (raw != null) {
                currentCache.put(raw, blockSignature);
            }
            signature.append(i)
                    .append(':')
                    .append(message.type)
                    .append(':')
                    .append(message.timestamp)
                    .append(':')
                    .append(blockSignature)
                    .append(';');
        }
        structuralSignatureCache = currentCache;
        return signature.toString();
    }

    private static String computeMessageStructuralSignature(JsonObject raw) {
        JsonArray blocks = MessageStructure.findContentArray(raw);
        if (blocks == null) {
            return "";
        }
        StringBuilder signature = new StringBuilder();
        for (JsonElement element : blocks) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            String type = block.has("type") && !block.get("type").isJsonNull()
                    ? block.get("type").getAsString() : "";
            if ("text".equals(type) || "thinking".equals(type)) {
                signature.append(type).append('|');
                continue;
            }
            signature.append(type).append(':');
            if ("tool_use".equals(type)) {
                appendFieldSignature(signature, block, "id");
                appendFieldSignature(signature, block, "name");
                appendElementSignature(signature, block, "input");
            } else if ("tool_result".equals(type)) {
                appendFieldSignature(signature, block, "tool_use_id");
                appendFieldSignature(signature, block, "is_error");
                appendElementSignature(signature, block, "content");
            } else if ("attachment".equals(type)) {
                appendFieldSignature(signature, block, "fileName");
                appendFieldSignature(signature, block, "mediaType");
            } else if ("image".equals(type)) {
                appendElementSignature(signature, block, "src");
                appendFieldSignature(signature, block, "mediaType");
            } else {
                appendValueSignature(signature, element.toString());
            }
            signature.append('|');
        }
        return signature.toString();
    }

    private static void appendFieldSignature(StringBuilder signature, JsonObject block, String fieldName) {
        if (!block.has(fieldName) || block.get(fieldName).isJsonNull()) {
            signature.append(fieldName).append("=;");
            return;
        }
        signature.append(fieldName).append('=').append(block.get(fieldName)).append(';');
    }

    private static void appendElementSignature(StringBuilder signature, JsonObject block, String fieldName) {
        if (!block.has(fieldName) || block.get(fieldName).isJsonNull()) {
            signature.append(fieldName).append("=;");
            return;
        }
        signature.append(fieldName).append('=');
        appendValueSignature(signature, block.get(fieldName).toString());
        signature.append(';');
    }

    /**
     * Append a bounded signature for a serialized JSON value. Two independent
     * hashes (Java string hash + FNV-1a) make a collision-driven missed
     * structural change practically impossible; the stream-end full flush
     * remains the final safety net.
     */
    private static void appendValueSignature(StringBuilder signature, String value) {
        signature.append(value.length())
                .append(':').append(value.hashCode())
                .append(':').append(fnv1a(value));
    }

    private static int fnv1a(String value) {
        int hash = 0x811c9dc5;
        for (int i = 0; i < value.length(); i++) {
            hash ^= value.charAt(i);
            hash *= 0x01000193;
        }
        return hash;
    }

    private boolean hasDeltaChannel() {
        if (!streamActive) {
            return false;
        }
        HandlerContext context = callbackTarget.getHandlerContext();
        if (context == null) {
            return false;
        }
        String provider = context.getCurrentProvider();
        return "claude".equals(provider) || "codex".equals(provider) || "grok".equals(provider)
                || "zcode".equals(provider);
    }

    private void startHeartbeat() {
        heartbeatAlarm.cancelAllRequests();
        scheduleHeartbeat();
    }

    private void scheduleHeartbeat() {
        if (!streamActive || disposed || callbackTarget.isDisposed()) {
            return;
        }
        heartbeatAlarm.addRequest(() -> {
            if (!streamActive || disposed || callbackTarget.isDisposed()) {
                return;
            }
            try {
                callbackTarget.callJavaScript("onStreamingHeartbeat");
                if (LOG.isDebugEnabled()) {
                    LOG.debug("[Heartbeat] Sent streaming heartbeat to frontend");
                }
            } catch (Exception e) {
                LOG.warn("[Heartbeat] Failed to send heartbeat: " + e.getMessage());
            }
            scheduleHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private static final class SnapshotThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "StreamMessageCoalescer");
            thread.setDaemon(true);
            return thread;
        }
    }
}
