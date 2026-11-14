package com.github.claudecodegui.voice;

import java.io.IOException;

/** Turns a WAV clip into text; {@link TranscriptionClient} is the HTTP implementation. */
@FunctionalInterface
public interface Transcriber {

    /**
     * @param prompt preceding transcript that keeps spelling and style consistent across
     *               live segments; empty for none
     */
    String transcribe(byte[] wav, VoiceInputConfig config, String prompt) throws IOException, InterruptedException;
}
