package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertTrue;

public class AiDataDirectoryLinksReviewTest {
    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void fallbackPreservesPercentAndDelayedExpansionCharactersInDirectoryNames() throws Exception {
        Assume.assumeTrue(PlatformUtils.isWindows() && System.getenv("OS") != null);
        Path root = temporary.getRoot().toPath();
        Path target = Files.createDirectory(root.resolve("target-%OS%-! & space"));
        Path canonical = root.resolve("link-%OS%-! & space");
        var fallback = AiDataDirectoryLinks.class.getDeclaredMethod("createWindowsJunctionWithMklink", Path.class, Path.class);
        fallback.setAccessible(true);
        fallback.invoke(null, canonical, target);
        try {
            assertTrue(Files.isSameFile(canonical, target));
        } finally {
            if (Files.exists(canonical)) {
                AiDataDirectoryLinks.deleteDirectoryLink(canonical);
            }
        }
    }
}
