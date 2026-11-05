package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class AiDataRelocationReviewRegressionTest {
    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void rollbackRetainsNewDataWrittenThroughThePublishedCanonicalLink() throws Exception {
        Path root = temporary.getRoot().toPath();
        Path home = Files.createDirectory(root.resolve("home"));
        Path source = Files.createDirectory(home.resolve(".codex"));
        Files.writeString(source.resolve("config.toml"), "original");
        Path target = Files.createDirectory(root.resolve("target"));
        Path coordination = root.resolve("coordination");
        AiDataDirectoryManager manager = new AiDataDirectoryManager(home, coordination.resolve("state"),
                PlatformUtils.PlatformType.WINDOWS, false, (canonical, destination) -> {
                    AiDataDirectoryLinks.createPlatformLink(canonical, destination, PlatformUtils.getPlatformType());
                    if (canonical.getFileName().toString().equals(".codex")) {
                        Files.writeString(canonical.resolve("late.txt"), "independent writer");
                    }
                }, new AiDataProcessGate(), AiDataDirectoryManager::deleteWritablePath,
                coordination, root.resolve("legacy"));

        IOException error = assertThrows(IOException.class, () -> manager.migrate(target.toString()));

        assertEquals("The rollback must preserve a conflicting target for recovery",
                "MIGRATION_ROLLBACK_FAILED", error.getMessage());
        assertEquals("independent writer", Files.readString(target.resolve(".codex/late.txt")));
        assertEquals("original", Files.readString(home.resolve(".codex/config.toml")));
        assertTrue(Files.exists(coordination.resolve("state/migration-journal.json")));
    }
}
