package com.github.claudecodegui.handler.history;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class SessionConversionPermissionsTest {
    private static final String SESSION_ID = "11111111-2222-3333-4444-555555555555";

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void theConvertedSessionAndItsBackupKeepTheOriginalPermissions() throws Exception {
        URI archive = URI.create("jar:" + this.folder.getRoot().toPath().resolve("posix.zip").toUri());
        try (FileSystem posix = FileSystems.newFileSystem(archive,
                Map.of("create", "true", "enablePosixFileAttributes", "true"))) {
            Path directory = Files.createDirectory(posix.getPath("/project"));
            Path session = directory.resolve(SESSION_ID + ".jsonl");
            Files.write(session, List.of("{\"entrypoint\":\"sdk-cli\",\"type\":\"user\"}"), StandardCharsets.UTF_8);
            Set<PosixFilePermission> original = PosixFilePermissions.fromString("rw-r-----");
            Files.setPosixFilePermissions(session, original);
            List<Set<PosixFilePermission>> backups = new ArrayList<>();
            SessionConversionService service = new SessionConversionService(null, channel -> {
                throw new UnsupportedOperationException("Locking unsupported");
            }, channel -> {
                try (Stream<Path> files = Files.list(directory)) {
                    for (Path file : files.filter(path -> path.toString().contains(".backup.")).toList()) {
                        backups.add(Files.getPosixFilePermissions(file));
                    }
                }
            });

            SessionConversionService.FileConversionResult result = service.convertSessionFile(session, SESSION_ID);

            assertTrue(result.success());
            assertTrue(Files.readString(session).contains("\"entrypoint\":\"cli\""));
            assertEquals(List.of(original), backups);
            assertEquals(original, Files.getPosixFilePermissions(session));
        }
    }
}
