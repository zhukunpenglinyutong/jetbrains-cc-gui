package com.github.claudecodegui.handler;

import com.github.claudecodegui.action.VoiceInputAction;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.voice.MicrophoneRecorder;
import com.github.claudecodegui.voice.Recording;
import com.github.claudecodegui.voice.SpeechSegmenter;
import com.github.claudecodegui.voice.TranscriptText;
import com.github.claudecodegui.voice.Transcriber;
import com.github.claudecodegui.voice.TranscriptionClient;
import com.github.claudecodegui.voice.VoiceInputConfig;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.keymap.KeymapUtil;
import com.intellij.util.concurrency.AppExecutorUtil;

import javax.sound.sampled.LineUnavailableException;
import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * Push-to-talk voice input: records the microphone on the IDE side and transcribes it
 * through an OpenAI-compatible endpoint, then hands the text to the webview input box.
 *
 * <p>Recording happens in Java rather than the webview because JCEF denies microphone access
 * by default and ships without the Web Speech API. In live mode each utterance is transcribed
 * as soon as the speaker pauses, so text appears while they keep talking.
 */
public class VoiceInputHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(VoiceInputHandler.class);

    static final String TYPE_START = "voice_input_start";
    static final String TYPE_STOP = "voice_input_stop";
    static final String TYPE_CANCEL = "voice_input_cancel";
    static final String TYPE_GET_CONFIG = "voice_input_get_config";
    static final String TYPE_SET_CONFIG = "voice_input_set_config";
    static final String TYPE_TEST_CONFIG = "voice_input_test_config";
    /** Sent by a freshly mounted chat input: no page is tracking an older session any more. */
    static final String TYPE_ATTACH = "voice_input_attach";
    private static final String[] SUPPORTED_TYPES = {
        TYPE_START, TYPE_STOP, TYPE_CANCEL, TYPE_GET_CONFIG, TYPE_SET_CONFIG, TYPE_TEST_CONFIG, TYPE_ATTACH,
    };
    /** Settings requests carry an id that the reply echoes, so the page can match them. */
    static final String REQUEST_ID = "requestId";

    static final String JS_UPDATE = "window.onVoiceInputUpdate";
    static final String JS_CONFIG = "window.updateVoiceInputConfig";
    static final String JS_TEST_RESULT = "window.onVoiceInputTestResult";
    /** One second of silence: a valid request every endpoint answers quickly with empty text. */
    private static final double TEST_CLIP_SECONDS = 1.0;
    private static final double MIN_CLIP_SECONDS = 0.3;
    /** Trailing transcript passed as the prompt for the next live segment. */
    private static final int LIVE_CONTEXT_CHARS = 200;
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    /** Redirects are refused: Java's client would replay the Authorization header to the new host. */
    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(CONNECT_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    /** Reads and updates ~/.codemoss/config.json. */
    interface ConfigStore {
        JsonObject read() throws IOException;

        void update(Consumer<JsonObject> change) throws IOException;
    }

    /** Runs start, stop, cancel and saves one at a time, in arrival order. */
    private final Executor control;
    /** Blocking work (uploads, microphone shutdown); never delays control messages. */
    private final Executor background;
    private final Executor edt;
    private final Transcriber transcriber;
    private final Recording.Factory recorders;
    private final ConfigStore configStore;
    private final Supplier<String> shortcutText;
    private final Object lock = new Object();
    /** The recording, or the transcription still finishing after it; one at a time per chat window. */
    private Session active;
    private boolean disposed;

    public VoiceInputHandler(HandlerContext context) {
        this(context,
                logged(AppExecutorUtil.createBoundedApplicationPoolExecutor("CC GUI Voice Input", 1)),
                logged(runnable -> ApplicationManager.getApplication().executeOnPooledThread(runnable)),
                runnable -> ApplicationManager.getApplication().invokeLater(runnable),
                new TranscriptionClient(HTTP_CLIENT),
                MicrophoneRecorder::start,
                new ConfigStore() {
                    @Override
                    public JsonObject read() throws IOException {
                        return context.getSettingsService().readConfig();
                    }

                    @Override
                    public void update(Consumer<JsonObject> change) throws IOException {
                        context.getSettingsService().updateConfig(change);
                    }
                },
                () -> KeymapUtil.getFirstKeyboardShortcutText(VoiceInputAction.ID));
    }

    VoiceInputHandler(HandlerContext context, Executor control, Executor background, Executor edt,
                      Transcriber transcriber, Recording.Factory recorders, ConfigStore configStore,
                      Supplier<String> shortcutText) {
        super(context);
        this.control = control;
        this.background = background;
        this.edt = edt;
        this.transcriber = transcriber;
        this.recorders = recorders;
        this.configStore = configStore;
        this.shortcutText = shortcutText;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case TYPE_START -> control.execute(this::startRecording);
            case TYPE_STOP -> control.execute(() -> stopRecording(null));
            case TYPE_CANCEL -> control.execute(this::cancelRecording);
            case TYPE_GET_CONFIG -> control.execute(() -> pushConfig(requestId(content)));
            case TYPE_SET_CONFIG -> control.execute(() -> saveConfig(content));
            case TYPE_TEST_CONFIG -> background.execute(() -> testConfig(content));
            case TYPE_ATTACH -> control.execute(this::attach);
            default -> {
                return false;
            }
        }
        return true;
    }

    /** Releases the microphone when the chat window closes; the webview cannot ask any more. */
    public void dispose() {
        Session session;
        synchronized (lock) {
            disposed = true;
            session = active;
            active = null;
        }
        if (session != null) {
            session.cancelled = true;
            session.recording.cancel();
            LOG.info("[VoiceInput] Recording cancelled because the chat window closed");
        }
    }

    private void startRecording() {
        VoiceInputConfig config;
        try {
            config = loadConfig();
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Failed to read config", e);
            sendIdle(VoiceInputError.CONFIG_UNREADABLE.code, e.getMessage());
            return;
        }
        VoiceInputConfig.Problem problem = config.problem();
        if (problem != null) {
            sendIdle(problem.code, null);
            return;
        }

        synchronized (lock) {
            if (disposed) {
                return;
            }
            if (active != null) {
                sendState(active.transcribing ? "transcribing" : "recording");
                return;
            }
        }
        // Opened outside the lock: a slow device must not block dispose() on the EDT. Control
        // messages are sequential, so no other start can slip in meanwhile.
        Session session = new Session(config);
        try {
            session.recording = recorders.start(background, session, config.liveTranscription());
        } catch (LineUnavailableException | RuntimeException e) {
            LOG.warn("[VoiceInput] Microphone unavailable", e);
            sendIdle(VoiceInputError.MIC_UNAVAILABLE.code, e.getMessage());
            return;
        }
        synchronized (lock) {
            if (disposed) {
                session.recording.cancel();
                return;
            }
            active = session;
        }
        LOG.info("[VoiceInput] Recording started (live=" + config.liveTranscription() + ")");
        sendState("recording");
    }

    /** Stops the active session; with {@code expected} set, only if that session is still the active one. */
    private void stopRecording(Session expected) {
        Session session;
        synchronized (lock) {
            session = active;
            if (expected != null && session != expected) {
                return;
            }
            if (session == null) {
                sendIdle(null, null);
                return;
            }
            if (session.transcribing) {
                return;
            }
            session.transcribing = true;
        }
        sendState("transcribing");
        if (session.config.liveTranscription()) {
            background.execute(() -> finishLive(session));
        } else {
            background.execute(() -> transcribeClip(session));
        }
    }

    private void transcribeClip(Session session) {
        try {
            byte[] wav = session.recording.stopAsWav();
            double seconds = session.recording.capturedSeconds();
            if (seconds < MIN_CLIP_SECONDS) {
                finish(session, VoiceInputError.TOO_SHORT, null);
                return;
            }
            long startedAt = System.nanoTime();
            String text = clean(session, transcriber.transcribe(wav, session.config, ""));
            LOG.info(String.format("[VoiceInput] Transcribed %.1fs clip in %d ms (%d chars)",
                    seconds, elapsedMs(startedAt), text.length()));
            sendText(session, text);
            finish(session, text.isEmpty() ? VoiceInputError.NO_SPEECH : null, null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            finish(session, VoiceInputError.TRANSCRIPTION_FAILED, "interrupted");
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Transcription failed", e);
            finish(session, VoiceInputError.TRANSCRIPTION_FAILED, e.getMessage());
        }
    }

    private void finishLive(Session session) {
        try {
            SpeechSegmenter.Segment tail = session.recording.stopAndFlush();
            if (tail != null) {
                session.enqueue(() -> transcribeSegment(session, tail));
            }
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Failed to stop microphone", e);
        }
        session.enqueue(() -> {
            VoiceInputError error = session.anyText || session.errorReported ? null : VoiceInputError.NO_SPEECH;
            finish(session, error, null);
        });
    }

    /** Runs on the session's ordered chain, so segments land in the order they were spoken. */
    private void transcribeSegment(Session session, SpeechSegmenter.Segment segment) {
        if (session.cancelled || !segment.hasSpeech()) {
            return;
        }
        try {
            long startedAt = System.nanoTime();
            String text = clean(session, transcriber.transcribe(
                    MicrophoneRecorder.toWav(segment.pcm()), session.config, session.context()));
            LOG.info(String.format("[VoiceInput] Transcribed %.1fs live segment in %d ms (%d chars)",
                    segment.pcm().length / (double) MicrophoneRecorder.BYTES_PER_SECOND, elapsedMs(startedAt), text.length()));
            if (!text.isEmpty()) {
                sendText(session, session.append(text));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Live segment transcription failed", e);
            // One toast per recording; later segments may still succeed.
            if (!session.errorReported && !session.cancelled) {
                session.errorReported = true;
                sendError(VoiceInputError.TRANSCRIPTION_FAILED, e.getMessage());
            }
        }
    }

    /** Works while recording and while a transcription is still running; late results are dropped. */
    private void cancelRecording() {
        dropActiveSession("[VoiceInput] Recording cancelled");
        sendIdle(null, null);
    }

    /** A reloaded page skips React cleanup, so an older session would otherwise keep the mic open unseen. */
    private void attach() {
        dropActiveSession("[VoiceInput] Recording dropped: the chat input was reloaded");
        pushShortcut();
    }

    private void dropActiveSession(String logMessage) {
        Session session;
        synchronized (lock) {
            session = active;
            active = null;
        }
        if (session != null) {
            session.cancelled = true;
            session.recording.cancel();
            LOG.info(logMessage);
        }
    }

    private void finish(Session session, VoiceInputError error, String detail) {
        synchronized (lock) {
            if (active != session) {
                return;
            }
            active = null;
        }
        if (!session.cancelled) {
            sendIdle(error != null ? error.code : null, detail);
        }
    }

    private void testConfig(String content) {
        JsonObject result = new JsonObject();
        try {
            JsonObject update = JsonParser.parseString(content).getAsJsonObject();
            VoiceInputConfig config = VoiceInputConfig.preview(configStore.read(), update);
            VoiceInputConfig.Problem problem = config.problem();
            if (problem != null) {
                result.addProperty("ok", false);
                result.addProperty("errorCode", problem.code);
            } else {
                byte[] silence = new byte[(int) (TEST_CLIP_SECONDS * MicrophoneRecorder.BYTES_PER_SECOND)];
                long startedAt = System.nanoTime();
                transcriber.transcribe(MicrophoneRecorder.toWav(silence), config, "");
                result.addProperty("ok", true);
                result.addProperty("latencyMs", elapsedMs(startedAt));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            result.addProperty("ok", false);
            result.addProperty("error", "interrupted");
        } catch (IOException | RuntimeException e) {
            LOG.info("[VoiceInput] Connection test failed: " + e.getMessage());
            result.addProperty("ok", false);
            result.addProperty("error", e.getMessage());
        }
        send(JS_TEST_RESULT, result);
    }

    private static String clean(Session session, String text) {
        String normalized = TranscriptText.normalize(text);
        return session.fillers != null ? TranscriptText.removeFillers(normalized, session.fillers) : normalized;
    }

    private static long elapsedMs(long startedAt) {
        return (System.nanoTime() - startedAt) / 1_000_000;
    }

    private void pushShortcut() {
        JsonObject update = new JsonObject();
        update.addProperty("shortcut", shortcutText.get());
        send(JS_UPDATE, update);
    }

    private void pushConfig(Long requestId) {
        try {
            JsonObject settings = loadConfig().toSettingsJson();
            settings.addProperty("shortcut", shortcutText.get());
            withRequestId(settings, requestId);
            send(JS_CONFIG, settings);
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Failed to read config", e);
            sendSettingsError(requestId, e.getMessage());
        }
    }

    private void saveConfig(String content) {
        Long requestId = requestId(content);
        try {
            JsonObject update = JsonParser.parseString(content).getAsJsonObject();
            update.remove(REQUEST_ID);
            configStore.update(root -> VoiceInputConfig.applyUpdate(root, update));
            LOG.info("[VoiceInput] Settings saved");
            pushConfig(requestId);
        } catch (IOException | RuntimeException e) {
            LOG.warn("[VoiceInput] Failed to save settings", e);
            sendSettingsError(requestId, e.getMessage());
        }
    }

    /** The settings page has its own callback: the chat (and onVoiceInputUpdate) is unmounted while it is open. */
    private void sendSettingsError(Long requestId, String detail) {
        JsonObject payload = new JsonObject();
        payload.addProperty("error", detail != null && !detail.isBlank() ? detail : "unknown error");
        withRequestId(payload, requestId);
        send(JS_CONFIG, payload);
    }

    /** Reads the optional request id from a settings message; null when absent or malformed. */
    static Long requestId(String content) {
        try {
            JsonElement root = content == null || content.isBlank() ? null : JsonParser.parseString(content);
            if (root != null && root.isJsonObject()) {
                JsonElement id = root.getAsJsonObject().get(REQUEST_ID);
                if (id != null && id.isJsonPrimitive() && id.getAsJsonPrimitive().isNumber()) {
                    return id.getAsLong();
                }
            }
        } catch (RuntimeException ignored) {
            // A malformed message still gets an (unmatched) reply.
        }
        return null;
    }

    private static void withRequestId(JsonObject payload, Long requestId) {
        if (requestId != null) {
            payload.addProperty(REQUEST_ID, requestId);
        }
    }

    private VoiceInputConfig loadConfig() throws IOException {
        return VoiceInputConfig.from(configStore.read());
    }

    private void sendText(Session session, String text) {
        if (session.cancelled || text.isEmpty()) {
            return;
        }
        JsonObject update = new JsonObject();
        update.addProperty("text", text);
        send(JS_UPDATE, update);
    }

    private void sendState(String state) {
        JsonObject update = new JsonObject();
        update.addProperty("state", state);
        send(JS_UPDATE, update);
    }

    private void sendIdle(String errorCode, String detail) {
        JsonObject update = errorPayload(errorCode, detail);
        update.addProperty("state", "idle");
        send(JS_UPDATE, update);
    }

    /** Reports an error without changing the recording state. */
    private void sendError(VoiceInputError error, String detail) {
        send(JS_UPDATE, errorPayload(error.code, detail));
    }

    private static JsonObject errorPayload(String errorCode, String detail) {
        JsonObject update = new JsonObject();
        if (errorCode != null) {
            update.addProperty("errorCode", errorCode);
        }
        if (detail != null && !detail.isBlank()) {
            update.addProperty("error", detail);
        }
        return update;
    }

    private void send(String callback, JsonObject payload) {
        String json = payload.toString();
        edt.execute(() -> callJavaScript(callback, escapeJs(json)));
    }

    /** Pooled threads keep task failures inside a discarded Future; log them so they are not silent. */
    private static Executor logged(Executor delegate) {
        return runnable -> delegate.execute(() -> {
            try {
                runnable.run();
            } catch (RuntimeException | LinkageError e) {
                LOG.error("[VoiceInput] Background task failed", e);
            }
        });
    }

    /** One recording and its transcription. */
    private final class Session implements Recording.Listener {
        final VoiceInputConfig config;
        final Pattern fillers;
        Recording recording;
        /** Guarded by {@link #lock}. */
        boolean transcribing;
        volatile boolean cancelled;
        private CompletableFuture<Void> chain = CompletableFuture.completedFuture(null);
        // Touched only by tasks on the chain, which run one at a time.
        private final StringBuilder transcript = new StringBuilder();
        boolean anyText;
        boolean errorReported;

        Session(VoiceInputConfig config) {
            this.config = config;
            this.fillers = TranscriptText.fillerPattern(config.fillerWords());
        }

        @Override
        public void onSegment(SpeechSegmenter.Segment segment) {
            enqueue(() -> transcribeSegment(this, segment));
        }

        @Override
        public void onLimitReached() {
            LOG.info("[VoiceInput] Recording limit reached, transcribing");
            control.execute(() -> stopRecording(this));
        }

        synchronized void enqueue(Runnable task) {
            // A failed task must not skip the ones queued behind it, including the final idle.
            chain = chain.exceptionally(e -> null).thenRunAsync(task, background);
        }

        /** Records a live phrase and returns it as it should be inserted after the previous ones. */
        String append(String text) {
            String inserted = TranscriptText.continuation(transcript.toString(), text);
            if (!transcript.isEmpty() && !inserted.startsWith(".")) {
                transcript.append(' ');
            }
            transcript.append(inserted);
            anyText = true;
            return inserted;
        }

        String context() {
            int start = Math.max(0, transcript.length() - LIVE_CONTEXT_CHARS);
            return transcript.substring(start);
        }
    }

    /** Error codes the webview maps to localized messages; config problems use {@link VoiceInputConfig.Problem}. */
    enum VoiceInputError {
        MIC_UNAVAILABLE("mic_unavailable"),
        TOO_SHORT("too_short"),
        NO_SPEECH("no_speech"),
        CONFIG_UNREADABLE("config_unreadable"),
        TRANSCRIPTION_FAILED("transcription_failed");

        final String code;

        VoiceInputError(String code) {
            this.code = code;
        }
    }
}
