package com.github.claudecodegui.voice;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SpeechSegmenterTest {

    private static final int BYTES_PER_SECOND = 32_000;
    private static final int CHUNK_BYTES = 4096;

    @Test
    public void cutsAtPauseBetweenPhrases() {
        SpeechSegmenter segmenter = new SpeechSegmenter(BYTES_PER_SECOND);
        List<SpeechSegmenter.Segment> segments = new ArrayList<>();

        feed(segmenter, segments, tone(2.0, 4000));
        feed(segmenter, segments, quiet(1.0));
        feed(segmenter, segments, tone(2.0, 4000));
        SpeechSegmenter.Segment tail = segmenter.flush();

        assertEquals(1, segments.size());
        assertTrue(segments.get(0).hasSpeech());
        assertTrue(seconds(segments.get(0)) >= 2.0 + SpeechSegmenter.PAUSE_SECONDS - 0.2);
        assertTrue(seconds(segments.get(0)) <= 3.0);
        assertTrue(tail.hasSpeech());
    }

    @Test
    public void shortBlipDoesNotCloseASegment() {
        SpeechSegmenter segmenter = new SpeechSegmenter(BYTES_PER_SECOND);
        List<SpeechSegmenter.Segment> segments = new ArrayList<>();

        feed(segmenter, segments, tone(0.3, 4000));
        feed(segmenter, segments, quiet(0.9));

        assertTrue(segments.isEmpty());
        assertTrue(segmenter.flush().hasSpeech());
    }

    @Test
    public void forcesCutDuringLongMonologue() {
        SpeechSegmenter segmenter = new SpeechSegmenter(BYTES_PER_SECOND);
        List<SpeechSegmenter.Segment> segments = new ArrayList<>();

        feed(segmenter, segments, tone(SpeechSegmenter.MAX_SEGMENT_SECONDS + 5, 4000));

        assertEquals(1, segments.size());
        assertTrue(seconds(segments.get(0)) <= SpeechSegmenter.MAX_SEGMENT_SECONDS + 0.2);
    }

    @Test
    public void silenceOnlyIsTrimmedToPreRollAndFlagged() {
        SpeechSegmenter segmenter = new SpeechSegmenter(BYTES_PER_SECOND);
        List<SpeechSegmenter.Segment> segments = new ArrayList<>();

        feed(segmenter, segments, noise(10.0, 120));
        SpeechSegmenter.Segment tail = segmenter.flush();

        assertTrue(segments.isEmpty());
        assertFalse(tail.hasSpeech());
        assertTrue(seconds(tail) <= 2.2);
        assertNull(segmenter.flush());
    }

    @Test
    public void loudBackgroundRaisesTheSpeechThreshold() {
        SpeechSegmenter segmenter = new SpeechSegmenter(BYTES_PER_SECOND);
        List<SpeechSegmenter.Segment> segments = new ArrayList<>();

        // Steady fan noise above the absolute floor is learned as background, not speech.
        feed(segmenter, segments, noise(1.0, 350));
        feed(segmenter, segments, noise(1.0, 400));

        assertFalse(segmenter.flush().hasSpeech());
    }

    @Test
    public void rmsOfFullScaleSquareWave() {
        byte[] pcm = new byte[8];
        for (int i = 0; i < pcm.length; i += 2) {
            short value = (short) ((i / 2) % 2 == 0 ? 1000 : -1000);
            pcm[i] = (byte) value;
            pcm[i + 1] = (byte) (value >> 8);
        }
        assertEquals(1000.0, SpeechSegmenter.rms(pcm, pcm.length), 0.001);
    }

    private static void feed(SpeechSegmenter segmenter, List<SpeechSegmenter.Segment> out, byte[] pcm) {
        for (int offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
            int length = Math.min(CHUNK_BYTES, pcm.length - offset);
            byte[] chunk = new byte[length];
            System.arraycopy(pcm, offset, chunk, 0, length);
            SpeechSegmenter.Segment segment = segmenter.accept(chunk, length);
            if (segment != null) {
                out.add(segment);
            }
        }
    }

    private static byte[] tone(double seconds, int amplitude) {
        int samples = (int) (seconds * BYTES_PER_SECOND / 2);
        byte[] pcm = new byte[samples * 2];
        for (int i = 0; i < samples; i++) {
            short value = (short) (amplitude * Math.sin(2 * Math.PI * 220 * i / 16_000.0));
            pcm[2 * i] = (byte) value;
            pcm[2 * i + 1] = (byte) (value >> 8);
        }
        return pcm;
    }

    /** Square wave whose RMS equals {@code level}: deterministic stand-in for background noise. */
    private static byte[] noise(double seconds, int level) {
        int samples = (int) (seconds * BYTES_PER_SECOND / 2);
        byte[] pcm = new byte[samples * 2];
        for (int i = 0; i < samples; i++) {
            short value = (short) (i % 2 == 0 ? level : -level);
            pcm[2 * i] = (byte) value;
            pcm[2 * i + 1] = (byte) (value >> 8);
        }
        return pcm;
    }

    private static byte[] quiet(double seconds) {
        return noise(seconds, 50);
    }

    private static double seconds(SpeechSegmenter.Segment segment) {
        return segment.pcm().length / (double) BYTES_PER_SECOND;
    }
}
