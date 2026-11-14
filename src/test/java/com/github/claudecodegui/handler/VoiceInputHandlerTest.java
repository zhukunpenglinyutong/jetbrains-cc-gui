package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.voice.Recording;
import com.github.claudecodegui.voice.SpeechSegmenter;
import com.github.claudecodegui.voice.VoiceInputConfig;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import javax.sound.sampled.LineUnavailableException;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Drives the voice-input state machine with fake microphone, transcriber and config store,
 * running every executor by hand so orderings can be forced.
 */
public class VoiceInputHandlerTest {

    private static final String VALID = """
            {"voiceInput": {"baseUrl": "https://stt.example.com/v1", "model": "m", "apiKey": "sk-secret-1234abcd",
             "liveTranscription": false, "fillerWords": "uh"}}
            """;

    @Test
    public void recordsTranscribesCleansAndReturnsToIdle() {
        Harness h = new Harness(VALID);
        h.transcriptions.add("Uh, refactor the billing service");

        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runAll();

        assertEquals(List.of("state:recording", "state:transcribing", "text:Refactor the billing service", "state:idle"),
                h.updateSummary());
        assertTrue(h.recording.stopped);
    }

    @Test
    public void configProblemIsReportedWithoutOpeningTheMicrophone() {
        Harness h = new Harness("{\"voiceInput\": {\"model\": \"m\"}}");

        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();

        assertEquals(List.of("state:idle error:missing_endpoint"), h.updateSummary());
        assertNull(h.recording);
    }

    @Test
    public void cancelQueuedBehindStartStillReleasesTheMicrophone() {
        Harness h = new Harness(VALID);

        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_CANCEL);
        h.runAll();

        assertTrue(h.recording.cancelled);
        assertEquals("state:idle", h.updateSummary().get(h.updateSummary().size() - 1));
    }

    @Test
    public void cancelDuringTranscriptionDropsTheLateText() {
        Harness h = new Harness(VALID);
        h.transcriptions.add("late text");
        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runControl();

        h.send(VoiceInputHandler.TYPE_CANCEL);
        h.runAll();

        assertFalse(h.updateSummary().stream().anyMatch(update -> update.startsWith("text:")));
        assertEquals("state:idle", h.updateSummary().get(h.updateSummary().size() - 1));
        assertEquals(1, h.updateSummary().stream().filter(update -> update.equals("state:idle")).count());
    }

    @Test
    public void unexpectedTranscriberFailureStillEndsTheSession() {
        Harness h = new Harness(VALID);
        h.transcriberFailure = new IllegalArgumentException("boom");

        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runAll();
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();

        List<String> updates = h.updateSummary();
        assertTrue(updates.contains("state:idle error:transcription_failed"));
        assertEquals("state:recording", updates.get(updates.size() - 1));
    }

    @Test
    public void silenceMarkerFromALocalServerCountsAsNoSpeech() {
        Harness h = new Harness(VALID);
        h.transcriptions.add(" [BLANK_AUDIO]\n");

        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runAll();

        assertFalse(h.updateSummary().stream().anyMatch(update -> update.startsWith("text:")));
        assertEquals("state:idle error:no_speech", h.updateSummary().get(h.updateSummary().size() - 1));
    }

    @Test
    public void tooShortClipIsNotUploaded() {
        Harness h = new Harness(VALID);
        h.capturedSeconds = 0.1;

        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runAll();

        assertEquals(0, h.uploads);
        assertEquals("state:idle error:too_short", h.updateSummary().get(h.updateSummary().size() - 1));
    }

    @Test
    public void disposeReleasesTheMicrophoneAndIgnoresLaterStarts() {
        Harness h = new Harness(VALID);
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();
        Recording first = h.recording;

        h.handler.dispose();
        h.recording = null;
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();

        assertTrue(((FakeRecording) first).cancelled);
        assertNull(h.recording);
    }

    @Test
    public void liveModeInsertsPhrasesInOrderAndSkipsSilence() {
        Harness h = new Harness(VALID.replace("\"liveTranscription\": false", "\"liveTranscription\": true"));
        h.transcriptions.add("Please refactor the billing service");
        h.transcriptions.add("Also add a retry");
        h.transcriptions.add("and write tests");

        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();
        assertTrue(h.liveRequested);
        h.listener.onSegment(new SpeechSegmenter.Segment(new byte[64], true));
        h.listener.onSegment(new SpeechSegmenter.Segment(new byte[64], false));
        h.listener.onSegment(new SpeechSegmenter.Segment(new byte[64], true));
        h.tail = new SpeechSegmenter.Segment(new byte[64], true);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runAll();

        assertEquals(3, h.uploads);
        assertEquals(List.of("state:recording", "state:transcribing", "text:Please refactor the billing service",
                "text:. Also add a retry", "text:and write tests", "state:idle"), h.updateSummary());
        assertEquals("Please refactor the billing service. Also add a retry", h.prompts.get(2));
    }

    @Test
    public void savingSettingsEchoesThemWithoutTheKey() {
        Harness h = new Harness(VALID);

        h.send(VoiceInputHandler.TYPE_SET_CONFIG, "{\"model\": \"whisper-large-v3\"}");
        h.runAll();

        assertEquals("whisper-large-v3", h.config.getAsJsonObject("voiceInput").get("model").getAsString());
        JsonObject echo = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_CONFIG)).getAsJsonObject();
        assertEquals("whisper-large-v3", echo.get("model").getAsString());
        assertEquals("Ctrl+Alt+Shift+M", echo.get("shortcut").getAsString());
        assertFalse(h.allPayloads().contains("sk-secret"));
    }

    @Test
    public void connectionTestReportsProblemsAndSuccessWithoutSaving() {
        Harness h = new Harness(VALID);
        String before = h.config.toString();

        h.send(VoiceInputHandler.TYPE_TEST_CONFIG, "{\"baseUrl\": \"http://stt.example.com/v1\"}");
        h.runAll();
        JsonObject insecure = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_TEST_RESULT)).getAsJsonObject();

        h.transcriptions.add("");
        h.send(VoiceInputHandler.TYPE_TEST_CONFIG, "{\"model\": \"other\"}");
        h.runAll();
        JsonObject ok = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_TEST_RESULT)).getAsJsonObject();

        assertFalse(insecure.get("ok").getAsBoolean());
        assertEquals("insecure_endpoint", insecure.get("errorCode").getAsString());
        assertTrue(ok.get("ok").getAsBoolean());
        assertNotNull(ok.get("latencyMs"));
        assertEquals("other", h.lastTestedModel);
        assertEquals(before, h.config.toString());
    }

    @Test
    public void settingsRepliesEchoTheRequestId() {
        Harness h = new Harness(VALID);

        h.send(VoiceInputHandler.TYPE_GET_CONFIG, "{\"requestId\": 7}");
        h.runAll();
        JsonObject load = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_CONFIG)).getAsJsonObject();
        h.send(VoiceInputHandler.TYPE_SET_CONFIG, "{\"model\": \"x\", \"requestId\": 8}");
        h.runAll();
        JsonObject save = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_CONFIG)).getAsJsonObject();

        assertEquals(7, load.get("requestId").getAsLong());
        assertEquals(8, save.get("requestId").getAsLong());
        assertFalse(h.config.getAsJsonObject("voiceInput").has("requestId"));
    }

    @Test
    public void attachFromAReloadedPageDropsTheOldSession() {
        Harness h = new Harness(VALID);
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();

        h.send(VoiceInputHandler.TYPE_ATTACH);
        h.runAll();

        assertTrue(h.recording.cancelled);
        JsonObject last = JsonParser.parseString(h.lastPayload(VoiceInputHandler.JS_UPDATE)).getAsJsonObject();
        assertEquals("Ctrl+Alt+Shift+M", last.get("shortcut").getAsString());
    }

    @Test
    public void limitReachedOnlyStopsTheSessionThatHitIt() {
        Harness h = new Harness(VALID);
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();
        Recording.Listener oldSession = h.listener;
        h.send(VoiceInputHandler.TYPE_CANCEL);
        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();
        FakeRecording current = h.recording;

        oldSession.onLimitReached();
        h.runAll();

        assertFalse(current.stopped);
        assertEquals("state:recording", h.updateSummary().get(h.updateSummary().size() - 1));
    }

    @Test
    public void disposeDuringUploadDropsTheResult() {
        Harness h = new Harness(VALID);
        h.transcriptions.add("too late");
        h.send(VoiceInputHandler.TYPE_START);
        h.send(VoiceInputHandler.TYPE_STOP);
        h.runControl();
        int updatesBefore = h.updateSummary().size();

        h.handler.dispose();
        h.runAll();

        assertEquals(updatesBefore, h.updateSummary().size());
    }

    @Test
    public void unexpectedMicrophoneFailureIsReported() {
        Harness h = new Harness(VALID);
        h.microphoneFailure = new IllegalStateException("no mixer");

        h.send(VoiceInputHandler.TYPE_START);
        h.runAll();

        assertEquals(List.of("state:idle error:mic_unavailable"), h.updateSummary());
    }

    /** Wires the handler to fakes; nothing runs until a run* method drains the queues. */
    private static final class Harness implements HandlerContext.JsCallback {
        final Queue<Runnable> control = new ArrayDeque<>();
        final Queue<Runnable> background = new ArrayDeque<>();
        final List<String[]> calls = new ArrayList<>();
        final Queue<String> transcriptions = new ArrayDeque<>();
        final List<String> prompts = new ArrayList<>();
        final JsonObject config;
        final VoiceInputHandler handler;
        FakeRecording recording;
        Recording.Listener listener;
        boolean liveRequested;
        SpeechSegmenter.Segment tail;
        RuntimeException transcriberFailure;
        RuntimeException microphoneFailure;
        double capturedSeconds = 2.0;
        int uploads;
        String lastTestedModel;

        Harness(String configJson) {
            this.config = JsonParser.parseString(configJson).getAsJsonObject();
            Executor controlExecutor = control::add;
            Executor backgroundExecutor = background::add;
            this.handler = new VoiceInputHandler(
                    new HandlerContext(null, null, null, null, this),
                    controlExecutor, backgroundExecutor, Runnable::run,
                    this::transcribe, this::startRecording,
                    new VoiceInputHandler.ConfigStore() {
                        @Override
                        public JsonObject read() {
                            return config.deepCopy();
                        }

                        @Override
                        public void update(Consumer<JsonObject> change) {
                            change.accept(config);
                        }
                    },
                    () -> "Ctrl+Alt+Shift+M");
        }

        void send(String type) {
            send(type, "");
        }

        void send(String type, String content) {
            assertTrue(handler.handle(type, content));
        }

        void runControl() {
            while (!control.isEmpty()) {
                control.poll().run();
            }
        }

        void runAll() {
            while (!control.isEmpty() || !background.isEmpty()) {
                runControl();
                if (!background.isEmpty()) {
                    background.poll().run();
                }
            }
        }

        private String transcribe(byte[] wav, VoiceInputConfig config, String prompt) {
            uploads++;
            prompts.add(prompt);
            lastTestedModel = config.model();
            if (transcriberFailure != null) {
                throw transcriberFailure;
            }
            String text = transcriptions.poll();
            return text != null ? text : "";
        }

        private Recording startRecording(Executor reader, Recording.Listener listener, boolean live)
                throws LineUnavailableException {
            if (microphoneFailure != null) {
                throw microphoneFailure;
            }
            this.listener = listener;
            this.liveRequested = live;
            this.recording = new FakeRecording(this);
            return recording;
        }

        List<String> updateSummary() {
            List<String> summary = new ArrayList<>();
            for (String[] call : calls) {
                if (!call[0].equals(VoiceInputHandler.JS_UPDATE)) {
                    continue;
                }
                JsonObject update = JsonParser.parseString(call[1]).getAsJsonObject();
                if (update.has("text")) {
                    summary.add("text:" + update.get("text").getAsString());
                } else if (update.has("state")) {
                    summary.add("state:" + update.get("state").getAsString()
                            + (update.has("errorCode") ? " error:" + update.get("errorCode").getAsString() : ""));
                }
            }
            return summary;
        }

        String lastPayload(String callback) {
            String last = null;
            for (String[] call : calls) {
                if (call[0].equals(callback)) {
                    last = call[1];
                }
            }
            assertNotNull("no call to " + callback, last);
            return last;
        }

        String allPayloads() {
            StringBuilder all = new StringBuilder();
            calls.forEach(call -> all.append(call[1]));
            return all.toString();
        }

        @Override
        public void callJavaScript(String functionName, String... args) {
            calls.add(new String[] {functionName, args.length > 0 ? args[0] : ""});
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }

    private static final class FakeRecording implements Recording {
        private final Harness harness;
        boolean stopped;
        boolean cancelled;

        FakeRecording(Harness harness) {
            this.harness = harness;
        }

        @Override
        public byte[] stopAsWav() {
            stopped = true;
            return new byte[] {'R', 'I', 'F', 'F'};
        }

        @Override
        public SpeechSegmenter.Segment stopAndFlush() throws IOException {
            stopped = true;
            return harness.tail;
        }

        @Override
        public void cancel() {
            cancelled = true;
        }

        @Override
        public double capturedSeconds() {
            return harness.capturedSeconds;
        }
    }
}
