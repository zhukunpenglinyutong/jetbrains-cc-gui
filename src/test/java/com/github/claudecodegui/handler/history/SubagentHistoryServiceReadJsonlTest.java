package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class SubagentHistoryServiceReadJsonlTest {

    private static Path writeTranscript(String... lines) throws IOException {
        Path file = Files.createTempFile("cc-gui-subagent-", ".jsonl");
        file.toFile().deleteOnExit();
        Files.writeString(file, String.join("\n", lines) + "\n", StandardCharsets.UTF_8);
        return file;
    }

    private static final String VALID_USER =
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}";
    private static final String VALID_ASSISTANT =
            "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}";
    /** An unterminated line, exactly what a writer mid-append leaves behind. */
    private static final String TORN_TAIL =
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"tor";
    /** A complete-looking but unparseable row: permanent damage, never heals. */
    private static final String INTERIOR_DAMAGE = "{\"type\":\"assistant\",\"uuid\":\"broken";

    @Test
    public void readsACompleteTranscript() throws IOException {
        JsonArray messages = SubagentHistoryService.readJsonl(
                writeTranscript(VALID_USER, VALID_ASSISTANT));

        assertEquals(2, messages.size());
    }

    @Test
    public void rejectsATornTail() throws IOException {
        try {
            SubagentHistoryService.readJsonl(writeTranscript(VALID_USER, TORN_TAIL));
            fail("a transcript whose last line is torn must not be read as complete");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("incomplete"));
        }
    }

    @Test
    public void skipsInteriorDamageFollowedByValidRows() throws IOException {
        // The damaged row is followed by valid ones, so the file is not being
        // written: this is permanent corruption that retries can never heal.
        JsonArray messages = SubagentHistoryService.readJsonl(
                writeTranscript(VALID_USER, INTERIOR_DAMAGE, VALID_ASSISTANT));

        assertEquals(2, messages.size());
    }

    @Test
    public void rejectsATornTailThatFollowsInteriorDamage() throws IOException {
        // Interior damage AND an unterminated last line. Only the LAST malformed
        // line decides: the valid row between them must not mark the file as
        // merely interior-damaged and let a truncated tail pass as complete.
        try {
            SubagentHistoryService.readJsonl(
                    writeTranscript(VALID_USER, INTERIOR_DAMAGE, VALID_ASSISTANT, TORN_TAIL));
            fail("a torn tail after interior damage must still be reported incomplete");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("incomplete"));
        }
    }

    @Test
    public void tornMultibyteUtf8TailIsReportedIncomplete() throws IOException {
        // A mid-append read whose write boundary splits a multi-byte character:
        // "中" is E4 B8 85 in UTF-8; the file ends after E4 B8. The lenient
        // decoder must degrade this to an unparseable last line (torn tail)
        // instead of throwing UncheckedIOException, which the caller would
        // surface as an error banner on a healthy subagent.
        Path file = Files.createTempFile("cc-gui-subagent-", ".jsonl");
        file.toFile().deleteOnExit();
        byte[] head = (VALID_USER + "\n{\"type\":\"user\",\"message\":{\"content\":\"中").getBytes(StandardCharsets.UTF_8);
        // Drop the final byte (0x85), leaving E4 B8 dangling mid-character.
        byte[] torn = new byte[head.length - 1];
        System.arraycopy(head, 0, torn, 0, torn.length);
        Files.write(file, torn);

        try {
            SubagentHistoryService.readJsonl(file);
            fail("a mid-character torn tail must be reported incomplete");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("incomplete"));
        }
    }

    @Test
    public void servesPrefixWhenTheTornTailIsStale() throws IOException {
        // The writer is gone (crashed/killed mid-append): the tail will never
        // heal, so the parseable prefix is served instead of reporting the
        // subagent as running forever.
        Path file = writeTranscript(VALID_USER, TORN_TAIL);
        Files.setLastModifiedTime(file, java.nio.file.attribute.FileTime.fromMillis(
                System.currentTimeMillis() - 60_000));

        JsonArray messages = SubagentHistoryService.readJsonl(file);

        assertEquals(1, messages.size());
    }

    @Test
    public void ignoresBlankLinesWhenDecidingTheTail() throws IOException {
        // Trailing blank lines are not the last record; a torn tail above them
        // is still a torn tail.
        JsonArray messages = SubagentHistoryService.readJsonl(
                writeTranscript(VALID_USER, VALID_ASSISTANT, "", "   "));

        assertEquals(2, messages.size());
    }
}
