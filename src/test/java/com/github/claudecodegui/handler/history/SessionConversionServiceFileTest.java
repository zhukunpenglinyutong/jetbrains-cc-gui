package com.github.claudecodegui.handler.history;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SessionConversionServiceFileTest {
    private static final String SESSION_ID = "11111111-2222-3333-4444-555555555555";

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private final SessionConversionService service = new SessionConversionService(null);

    @Test
    public void convertsASdkSessionFileOnDisk() throws Exception {
        Path file = this.writeSession(
                "{\"entrypoint\":\"sdk-cli\",\"type\":\"user\",\"text\":\"first\"}",
                "{\"type\":\"assistant\",\"text\":\"no entrypoint here\"}",
                "{\"entrypoint\":\"sdk-cli\",\"type\":\"user\",\"text\":\"second\"}");

        SessionConversionService.FileConversionResult result = this.service.convertSessionFile(file, SESSION_ID);

        assertTrue(result.success());
        assertNull(result.code());
        List<String> rows = Files.readAllLines(file, StandardCharsets.UTF_8);
        assertEquals(3, rows.size());
        assertTrue(rows.get(0).contains("\"entrypoint\":\"cli\""));
        assertEquals("{\"type\":\"assistant\",\"text\":\"no entrypoint here\"}", rows.get(1));
        assertTrue(rows.get(2).contains("\"entrypoint\":\"cli\""));
        assertEquals(List.of(SESSION_ID + ".jsonl"), this.directoryEntries());
    }

    @Test
    public void reportsAnAlreadyConvertedSessionWithoutChangingIt() throws Exception {
        Path file = this.writeSession("{\"entrypoint\":\"cli\",\"type\":\"user\"}");
        byte[] before = Files.readAllBytes(file);

        SessionConversionService.FileConversionResult result = this.service.convertSessionFile(file, SESSION_ID);

        assertTrue(result.success());
        assertEquals(ConversionResultCode.ALREADY_CLI_SESSION, result.code());
        assertArrayEquals(before, Files.readAllBytes(file));
        assertEquals(List.of(SESSION_ID + ".jsonl"), this.directoryEntries());
    }

    @Test
    public void keepsTheOriginalSessionWhenItCannotBeRewritten() throws Exception {
        Path file = this.folder.getRoot().toPath().resolve(SESSION_ID + ".jsonl");
        byte[] original = new byte[]{
                '{', '"', 'e', 'n', 't', 'r', 'y', 'p', 'o', 'i', 'n', 't', '"', ':', '"', 's', 'd', 'k', '-', 'c', 'l', 'i',
                '"', '}', '\n', (byte) 0xC3, (byte) 0x28, '\n'};
        Files.write(file, original);

        try {
            SessionConversionService.FileConversionResult result = this.service.convertSessionFile(file, SESSION_ID);
            assertFalse(result.success());
            assertEquals(ConversionResultCode.CONVERSION_FAILED, result.code());
        } catch (AssertionError loggedError) {
            assertTrue(loggedError.getMessage(), loggedError.getMessage().contains("Failed to convert session"));
        }
        assertArrayEquals(original, Files.readAllBytes(file));
        assertEquals(List.of(SESSION_ID + ".jsonl"), this.directoryEntries());
    }

    private Path writeSession(String... rows) throws Exception {
        Path file = this.folder.getRoot().toPath().resolve(SESSION_ID + ".jsonl");
        Files.write(file, List.of(rows), StandardCharsets.UTF_8);
        return file;
    }

    private List<String> directoryEntries() throws Exception {
        try (Stream<Path> entries = Files.list(this.folder.getRoot().toPath())) {
            return entries.map(path -> path.getFileName().toString()).sorted().collect(Collectors.toList());
        }
    }
}
