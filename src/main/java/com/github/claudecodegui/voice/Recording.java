package com.github.claudecodegui.voice;

import javax.sound.sampled.LineUnavailableException;
import java.io.IOException;
import java.util.concurrent.Executor;

/** One microphone capture; {@link MicrophoneRecorder} records the default input device. */
public interface Recording {

    /** Stops capturing and returns the whole clip as a WAV file. */
    byte[] stopAsWav() throws IOException;

    /** Stops a live-segmenting capture and returns the audio after the last emitted segment, or null. */
    SpeechSegmenter.Segment stopAndFlush() throws IOException;

    /** Stops capturing and discards the audio. */
    void cancel();

    /** Seconds of audio captured so far. */
    double capturedSeconds();

    /** Receives events from the capture thread. */
    interface Listener {
        /** Called with each utterance when the capture segments live; never called otherwise. */
        void onSegment(SpeechSegmenter.Segment segment);

        /** Called once when the maximum recording length elapses without a stop. */
        void onLimitReached();
    }

    /** Opens a capture; reading happens on {@code reader}. */
    @FunctionalInterface
    interface Factory {
        Recording start(Executor reader, Listener listener, boolean segmentLive) throws LineUnavailableException;
    }
}
