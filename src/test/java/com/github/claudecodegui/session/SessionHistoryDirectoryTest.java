package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Predicate;
import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create;
import static org.junit.Assert.*;

public class SessionHistoryDirectoryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void resumeUsesTheOriginalDirectoryAndTheIdeRootForMatching() throws Exception {
        Path root = temporary.getRoot().toPath();
        Path project = create(root.resolve("project"), "https://host/team/game.git");
        Path clone = create(root.resolve("clone"), "git@host:team/game.git");
        Path unrelated = create(root.resolve("unrelated"), "https://other/team/game.git");
        AtomicBoolean queried = new AtomicBoolean();
        CodemossSettingsService settings = new CodemossSettingsService() {
            @Override public boolean getSessionGitRepositoryMatchingEnabled() throws IOException { return true; }
        };
        ClaudeHistoryReader reader = new ClaudeHistoryReader() {
            @Override public String findSessionHistoryCwd(String id, String cwd, Predicate<String> match) {
                queried.set(true);
                assertEquals("saved-session", id);
                assertEquals(unrelated.toString(), cwd);
                assertTrue(match.test(clone.toString()));
                assertFalse(match.test(unrelated.toString()));
                return clone.toString();
            }
        };
        String restored = SessionLifecycleManager.resolveClaudeHistoryWorkingDirectory(
                "saved-session", unrelated.toString(), project.toString(), settings, reader);
        assertTrue(queried.get());
        assertEquals(clone.toString(), restored);
    }
}
