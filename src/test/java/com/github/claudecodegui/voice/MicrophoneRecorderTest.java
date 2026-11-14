package com.github.claudecodegui.voice;

import org.junit.Test;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import java.io.ByteArrayInputStream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

public class MicrophoneRecorderTest {

    @Test
    public void wrapsPcmInWavReadableAsSixteenKhzMono() throws Exception {
        byte[] pcm = new byte[32_000];
        for (int i = 0; i < pcm.length; i++) {
            pcm[i] = (byte) i;
        }

        byte[] wav = MicrophoneRecorder.toWav(pcm);

        try (AudioInputStream decoded = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            AudioFormat format = decoded.getFormat();
            assertEquals(16_000f, format.getSampleRate(), 0f);
            assertEquals(1, format.getChannels());
            assertEquals(16, format.getSampleSizeInBits());
            assertEquals(16_000, decoded.getFrameLength());
            assertArrayEquals(pcm, decoded.readAllBytes());
        }
    }
}
