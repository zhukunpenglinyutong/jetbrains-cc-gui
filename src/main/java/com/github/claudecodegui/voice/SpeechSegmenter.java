package com.github.claudecodegui.voice;

import java.io.ByteArrayOutputStream;

/**
 * Splits a 16-bit mono PCM stream into utterances at pauses, so live transcription can
 * send each phrase while the user keeps talking.
 *
 * <p>Energy-based: a chunk counts as speech when its RMS clears both an absolute floor and
 * a multiple of the adaptive background-noise level. Not thread-safe; feed it from one thread.
 */
public final class SpeechSegmenter {

    static final int MIN_SPEECH_RMS = 300;
    static final double SPEECH_TO_NOISE_RATIO = 3.0;
    private static final double NOISE_SMOOTHING = 0.1;
    /** The first chunk seeds the noise level; capped in case the user is already talking at the press. */
    static final double MAX_INITIAL_NOISE_RMS = 500;
    static final double PAUSE_SECONDS = 0.7;
    static final double MIN_SEGMENT_SECONDS = 1.5;
    static final double MAX_SEGMENT_SECONDS = 20;
    /** Silence kept before the first word so its onset is not clipped. */
    static final double PRE_ROLL_SECONDS = 0.5;
    private static final double MAX_LEADING_SILENCE_SECONDS = 2;

    private final int bytesPerSecond;
    private ByteArrayOutputStream current = new ByteArrayOutputStream();
    private boolean currentHasSpeech;
    private int trailingSilenceBytes;
    private double noiseRms = -1;

    /** One utterance (or leftover audio) ready for transcription. */
    public record Segment(byte[] pcm, boolean hasSpeech) {
    }

    public SpeechSegmenter(int bytesPerSecond) {
        this.bytesPerSecond = bytesPerSecond;
    }

    /**
     * Appends a chunk of samples and returns a finished segment when a pause or the
     * length cap closes one, otherwise null.
     */
    public Segment accept(byte[] chunk, int length) {
        boolean speech = isSpeech(rms(chunk, length));
        current.write(chunk, 0, length);

        if (speech) {
            currentHasSpeech = true;
            trailingSilenceBytes = 0;
        } else {
            trailingSilenceBytes += length;
        }

        if (!currentHasSpeech) {
            trimLeadingSilence();
            return null;
        }
        double seconds = seconds(current.size());
        boolean paused = seconds(trailingSilenceBytes) >= PAUSE_SECONDS && seconds >= MIN_SEGMENT_SECONDS;
        if (paused || seconds >= MAX_SEGMENT_SECONDS) {
            return takeSegment();
        }
        return null;
    }

    /** Returns whatever audio is buffered, or null when nothing is. */
    public Segment flush() {
        return current.size() == 0 ? null : takeSegment();
    }

    private boolean isSpeech(double rms) {
        if (noiseRms < 0) {
            noiseRms = Math.min(rms, MAX_INITIAL_NOISE_RMS);
        }
        boolean speech = rms >= Math.max(MIN_SPEECH_RMS, noiseRms * SPEECH_TO_NOISE_RATIO);
        if (!speech) {
            noiseRms += (rms - noiseRms) * NOISE_SMOOTHING;
        }
        return speech;
    }

    private void trimLeadingSilence() {
        if (seconds(current.size()) <= MAX_LEADING_SILENCE_SECONDS) {
            return;
        }
        byte[] buffered = current.toByteArray();
        int keep = alignToSample((int) (PRE_ROLL_SECONDS * bytesPerSecond));
        current = new ByteArrayOutputStream();
        current.write(buffered, buffered.length - keep, keep);
        trailingSilenceBytes = keep;
    }

    private Segment takeSegment() {
        Segment segment = new Segment(current.toByteArray(), currentHasSpeech);
        current = new ByteArrayOutputStream();
        currentHasSpeech = false;
        trailingSilenceBytes = 0;
        return segment;
    }

    private double seconds(int bytes) {
        return bytes / (double) bytesPerSecond;
    }

    private static int alignToSample(int bytes) {
        return bytes - (bytes % 2);
    }

    static double rms(byte[] chunk, int length) {
        int samples = length / 2;
        if (samples == 0) {
            return 0;
        }
        double sum = 0;
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (short) ((chunk[i] & 0xFF) | (chunk[i + 1] << 8));
            sum += (double) sample * sample;
        }
        return Math.sqrt(sum / samples);
    }
}
