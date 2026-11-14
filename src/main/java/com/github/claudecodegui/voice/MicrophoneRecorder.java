package com.github.claudecodegui.voice;

import com.intellij.openapi.diagnostic.Logger;

import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.TargetDataLine;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/**
 * Captures one push-to-talk clip from the default microphone as 16 kHz mono PCM.
 *
 * <p>Not reusable: create one instance per clip.
 */
public final class MicrophoneRecorder implements Recording {

    private static final Logger LOG = Logger.getInstance(MicrophoneRecorder.class);

    /** Whisper resamples to 16 kHz anyway; recording at that rate keeps uploads small (~32 KB/s). */
    static final AudioFormat FORMAT = new AudioFormat(16_000f, 16, 1, true, false);
    public static final int BYTES_PER_SECOND = FORMAT.getFrameSize() * (int) FORMAT.getFrameRate();
    /** Hard stop so a forgotten recording cannot hold the microphone or exceed upload limits (25 MB). */
    static final int MAX_RECORDING_SECONDS = 300;
    /** 128 ms of audio: fine enough for pause detection, coarse enough to keep reads cheap. */
    private static final int READ_BUFFER_BYTES = 4096;
    private static final long READER_JOIN_SECONDS = 2;

    private final TargetDataLine line;
    private final Listener listener;
    private final SpeechSegmenter segmenter;
    private final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
    private final CountDownLatch readerDone = new CountDownLatch(1);
    private volatile boolean stopped;
    private long capturedBytes;

    private MicrophoneRecorder(TargetDataLine line, Listener listener, boolean segmentLive) {
        this.line = line;
        this.listener = listener;
        this.segmenter = segmentLive ? new SpeechSegmenter(BYTES_PER_SECOND) : null;
    }

    /**
     * Opens the default microphone and starts capturing on {@code readerExecutor}.
     *
     * @param segmentLive emit utterances through {@link Listener#onSegment} while recording
     *                    instead of keeping one clip for {@link #stopAsWav()}
     */
    public static MicrophoneRecorder start(Executor readerExecutor, Listener listener, boolean segmentLive)
            throws LineUnavailableException {
        TargetDataLine line = AudioSystem.getTargetDataLine(FORMAT);
        line.open(FORMAT);
        line.start();
        MicrophoneRecorder recorder = new MicrophoneRecorder(line, listener, segmentLive);
        readerExecutor.execute(recorder::readLoop);
        return recorder;
    }

    @Override
    public byte[] stopAsWav() throws IOException {
        closeLine();
        awaitReader();
        byte[] samples;
        synchronized (pcm) {
            samples = pcm.toByteArray();
        }
        return toWav(samples);
    }

    @Override
    public SpeechSegmenter.Segment stopAndFlush() throws IOException {
        closeLine();
        awaitReader();
        return segmenter == null ? null : segmenter.flush();
    }

    @Override
    public void cancel() {
        closeLine();
    }

    @Override
    public double capturedSeconds() {
        synchronized (pcm) {
            return capturedBytes / (double) BYTES_PER_SECOND;
        }
    }

    public static byte[] toWav(byte[] samples) throws IOException {
        long frames = samples.length / FORMAT.getFrameSize();
        try (AudioInputStream stream = new AudioInputStream(new ByteArrayInputStream(samples), FORMAT, frames)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(samples.length + 64);
            AudioSystem.write(stream, AudioFileFormat.Type.WAVE, out);
            return out.toByteArray();
        }
    }

    private void readLoop() {
        long maxBytes = (long) MAX_RECORDING_SECONDS * BYTES_PER_SECOND;
        byte[] buffer = new byte[READ_BUFFER_BYTES];
        boolean limitReached = false;
        try {
            while (!stopped) {
                int read = line.read(buffer, 0, buffer.length);
                if (read <= 0) {
                    if (!line.isOpen()) {
                        break;
                    }
                    continue;
                }
                synchronized (pcm) {
                    capturedBytes += read;
                    if (segmenter == null) {
                        pcm.write(buffer, 0, read);
                    }
                    limitReached = capturedBytes >= maxBytes;
                }
                if (segmenter != null) {
                    SpeechSegmenter.Segment segment = segmenter.accept(buffer, read);
                    if (segment != null) {
                        listener.onSegment(segment);
                    }
                }
                if (limitReached) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            LOG.warn("[VoiceInput] Microphone read failed", e);
        } finally {
            readerDone.countDown();
        }
        if (limitReached && !stopped) {
            listener.onLimitReached();
        }
    }

    private void closeLine() {
        stopped = true;
        line.stop();
        line.close();
    }

    private void awaitReader() throws IOException {
        try {
            if (!readerDone.await(READER_JOIN_SECONDS, TimeUnit.SECONDS)) {
                LOG.warn("[VoiceInput] Microphone reader did not stop in time; using captured audio so far");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while stopping microphone", e);
        }
    }
}
