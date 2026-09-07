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
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.WeakHashMap;
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
    private List<ClaudeSession.Message> latestSourceMessages;
    private List<ClaudeSession.Message> lastSnapshot;
    private List<ClaudeSession.Message> lastDeliveredSnapshot;
    private String latestStructuralSignature;
    private boolean snapshotBuildRunning;
    private List<ClaudeSession.Message> requestedSnapshot;
    private long requestedSequence;
    private long requestedDeliveryEpoch;
    private long deliveryEpoch;
    private LongConsumer requestedAfterFlush;
    // A message's structural signature depends only on its raw tree, and the
    // streaming handler reassigns `raw` instead of mutating content blocks in
    // place (the in-place stamps — turnUsage / uuid / usage — are not part of
    // the signature). An unchanged raw reference therefore yields the same
    // signature, so cache by raw identity and recompute only for messages whose
    // raw changed — typically just the actively-streaming one. Weak keys let
    // entries for replaced raws and transport copies be garbage-collected.
    private final Map<JsonObject, String> structuralSignatureCache =
            Collections.synchronizedMap(new WeakHashMap<>());

    /**
     * Callback interface to push data to the webview.
     */
    public interface JsCallbackTarget {
        void callJavaScript(String functionName, String... args);
        boolean isDisposed();
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
     */
    public void enqueue(List<ClaudeSession.Message> messages) {
        if (disposed || callbackTarget.isDisposed() || messages == null) {
            return;
        }
        // Delta-capable providers keep text flowing through the lightweight channel;
        // snapshots remain for structure and final reconciliation.
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
            latestSourceMessages = List.copyOf(messages);
            boolean structuralChanged = !Objects.equals(latestStructuralSignature, structuralSignature);
            latestStructuralSignature = structuralSignature;
            active = streamActive;
            snapshotPending = snapshotPending || !active || !deltaChannelAvailable || structuralChanged;
            shouldSchedule = !active || !deltaChannelAvailable || structuralChanged;
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
     * deferred-reload drain must wait until the final snapshot has entered the
     * webview queue, which the adapter guarantees via its stream-end callback.
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
     */
    public void resetDeliveryBaseline() {
        synchronized (lock) {
            deliveryEpoch++;
            lastSnapshot = null;
            lastDeliveredSnapshot = null;
            lastPayloadChars = 0;
        }
    }

    /**
     * Return whether a snapshot is queued or currently being serialized.
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
            lastSnapshot = null;
            lastDeliveredSnapshot = null;
            latestStructuralSignature = null;
            requestedSnapshot = null;
            requestedAfterFlush = null;
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
     * @param afterFlush callback invoked after the snapshot has entered the webview queue
     */
    public void flush(LongConsumer afterFlush) {
        if (disposed || callbackTarget.isDisposed()) {
            return;
        }

        final List<ClaudeSession.Message> sourceMessages;
        final List<ClaudeSession.Message> snapshot;
        final long sequence;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            snapshotPending = false;
            sourceMessages = latestSourceMessages;
            sequence = ++updateSequence;
        }
        snapshot = sourceMessages != null
                ? copyMessagesForTransport(sourceMessages) : lastSnapshot;

        if (snapshot == null) {
            if (afterFlush != null) {
                afterFlush.accept(sequence);
            }
            return;
        }

        requestSnapshotBuild(snapshot, sequence, afterFlush);
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
            snapshot = sourceMessages == null ? null : copyMessagesForTransport(sourceMessages);

            if (disposed || callbackTarget.isDisposed()) {
                return;
            }
            if (snapshot != null) {
                requestSnapshotBuild(snapshot, sequence, null);
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
            LongConsumer afterFlush
    ) {
        boolean startWorker = false;
        synchronized (lock) {
            if (disposed) {
                return;
            }
            requestedSnapshot = messages;
            requestedSequence = sequence;
            requestedDeliveryEpoch = deliveryEpoch;
            if (afterFlush != null) {
                if (requestedAfterFlush == null) {
                    requestedAfterFlush = afterFlush;
                } else {
                    LongConsumer previous = requestedAfterFlush;
                    requestedAfterFlush = completedSequence -> {
                        previous.accept(completedSequence);
                        afterFlush.accept(completedSequence);
                    };
                }
            }
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
            deliveredSnapshot = lastDeliveredSnapshot;
            snapshotDeliveryEpoch = requestedDeliveryEpoch;
            requestedSnapshot = null;
            requestedAfterFlush = null;
            lastSnapshot = messages;
        }

        boolean sent = false;
        try {
            MessageTransport transport = selectMessageTransport(messages, deliveredSnapshot);
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
                        + ", sequence=" + sequence);
            } else if (LOG.isDebugEnabled()) {
                LOG.debug("[WebviewTransport] updateMessages payload chars=" + payloadChars
                        + ", messages=" + messages.size()
                        + ", buildMs=" + payloadBuildMs
                        + ", sequence=" + sequence);
            }

            final long pushSequence;
            synchronized (lock) {
                if (snapshotDeliveryEpoch != deliveryEpoch || sequence < lastPushedSequence) {
                    pushSequence = -1L;
                } else {
                    pushSequence = sequence;
                    lastPushedSequence = sequence;
                }
            }
            if (pushSequence >= 0L && !disposed && !callbackTarget.isDisposed()) {
                if (transport.tailUpdate()) {
                    callbackTarget.callJavaScript(
                            "updateMessageTail",
                            escapedMessagesJson,
                            String.valueOf(transport.baseIndex()),
                            String.valueOf(pushSequence));
                } else {
                    callbackTarget.callJavaScript(
                            "updateMessages", escapedMessagesJson, String.valueOf(pushSequence));
                }
                synchronized (lock) {
                    lastDeliveredSnapshot = messages;
                }
                String usageJson = MessageJsonConverter.buildUsageUpdateJson(
                        messages, callbackTarget.getHandlerContext());
                if (usageJson != null) {
                    callbackTarget.callJavaScript("onUsageUpdate", JsUtils.escapeJs(usageJson));
                }
                sent = true;
            }
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to serialize or push message snapshot: " + e.getMessage(), e);
        }

        runAfterFlush(afterFlush, sequence);

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
                }
                LOG.warn("Failed to continue message snapshot serialization: " + e.getMessage(), e);
                runAfterFlush(orphanedCallback, orphanedSequence);
            }
        }
        if (!sent && afterFlush == null && LOG.isDebugEnabled()) {
            LOG.debug("Message snapshot was not dispatched, sequence=" + sequence);
        }
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

    private String getStructuralSignature(List<ClaudeSession.Message> messages) {
        StringBuilder signature = new StringBuilder();
        for (int i = 0; i < messages.size(); i++) {
            ClaudeSession.Message message = messages.get(i);
            signature.append(i)
                    .append(':')
                    .append(message.type)
                    .append(':')
                    .append(message.timestamp)
                    .append(':')
                    .append(getCachedMessageStructuralSignature(message))
                    .append(';');
        }
        return signature.toString();
    }

    private String getCachedMessageStructuralSignature(ClaudeSession.Message message) {
        JsonObject raw = message.raw;
        if (raw == null) {
            return "";
        }
        return structuralSignatureCache.computeIfAbsent(
                raw, StreamMessageCoalescer::computeMessageStructuralSignature);
    }

    private static String computeMessageStructuralSignature(JsonObject raw) {
        JsonArray blocks = findContentArray(raw);
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

    private static JsonArray findContentArray(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content");
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject message = raw.getAsJsonObject("message");
            if (message.has("content") && message.get("content").isJsonArray()) {
                return message.getAsJsonArray("content");
            }
        }
        return null;
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
        return "claude".equals(provider) || "codex".equals(provider) || "grok".equals(provider);
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
