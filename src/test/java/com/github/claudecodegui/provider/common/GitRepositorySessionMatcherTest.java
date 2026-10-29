package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create;
import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.git;
import static org.junit.Assert.*;

public class GitRepositorySessionMatcherTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    @Test public void extractsNamesFromHttpsSshScpAndLocalRemotes() {
        for (String remote : new String[]{"https://host/team/game.git", "git@host:team/game.git",
                "ssh://git@host:2222/team/game.git/", "C:\\repos\\game.git", "https://host/team/game"}) {
            assertEquals("game", GitRepositorySessionMatcher.repositoryNameFromRemote(remote));
        }
        assertNull(GitRepositorySessionMatcher.repositoryNameFromRemote(" "));
    }

    @Test public void matchesSameNameAcrossDirectoriesAndRemoteHostsButRejectsOthers() throws Exception {
        Path project = create(tmp.getRoot().toPath().resolve("project"), "git@host:team/game.git");
        Path clone = create(tmp.getRoot().toPath().resolve("clone"), "https://another-host/fork/game.git");
        Path other = create(tmp.getRoot().toPath().resolve("other"), "https://host/team/different.git");
        GitRepositorySessionMatcher matcher = new GitRepositorySessionMatcher(Files.createDirectories(project.resolve("src")).toString());
        assertTrue(matcher.hasRepository());
        assertTrue(matcher.test(Files.createDirectories(clone.resolve("src/deep")).toString()));
        assertFalse(matcher.test(other.toString()));
        assertFalse(matcher.test(tmp.newFolder("no-git").toString()));
        assertFalse(matcher.test(tmp.getRoot().toPath().resolve("missing").toString()));
        assertFalse(matcher.test(null));
    }

    @Test public void fallsBackWithoutRemoteOrWithBrokenGitMetadata() throws Exception {
        Path local = create(tmp.getRoot().toPath().resolve("local"), null);
        assertFalse(new GitRepositorySessionMatcher(local.toString()).hasRepository());
        Path broken = tmp.newFolder("broken").toPath();
        Files.writeString(broken.resolve(".git"), "gitdir: missing-metadata\n");
        assertFalse(new GitRepositorySessionMatcher(broken.toString()).hasRepository());
    }

    @Test public void supportsRemotesWithoutOriginAndPrefersOriginWhenPresent() throws Exception {
        Path project = create(tmp.getRoot().toPath().resolve("project"), "https://host/team/game.git");
        Path clone = create(tmp.getRoot().toPath().resolve("clone"), null);
        git(clone, "remote", "add", "upstream", "https://host/team/game.git");
        assertTrue(new GitRepositorySessionMatcher(project.toString()).test(clone.toString()));
        git(clone, "remote", "add", "origin", "https://host/team/other.git");
        assertFalse(new GitRepositorySessionMatcher(project.toString()).test(clone.toString()));
    }

    @Test public void detectsWorktreeGitFilesAndRefreshesNamesOnTheNextLoad() throws Exception {
        Path project = create(tmp.getRoot().toPath().resolve("project"), "https://host/team/game.git");
        git(project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false",
                "commit", "--allow-empty", "--no-verify", "-m", "fixture");
        Path worktree = tmp.getRoot().toPath().resolve("worktree");
        git(project, "worktree", "add", "--detach", worktree.toString());
        assertTrue(Files.isRegularFile(worktree.resolve(".git")));
        assertTrue(new GitRepositorySessionMatcher(project.toString()).test(worktree.toString()));
        Path clone = create(tmp.getRoot().toPath().resolve("clone"), "https://host/team/game.git");
        GitRepositorySessionMatcher cached = new GitRepositorySessionMatcher(project.toString());
        assertTrue(cached.test(clone.toString()));
        git(clone, "remote", "set-url", "origin", "https://host/team/other.git");
        assertFalse(new GitRepositorySessionMatcher(project.toString()).test(clone.toString()));
    }

    @Test public void keepsCwdMatchesAndPaginationWhileAddingRepositoryMatches() throws Exception {
        Path project = create(tmp.getRoot().toPath().resolve("project"), "https://host/team/game.git");
        Path clone = create(tmp.getRoot().toPath().resolve("clone"), "https://host/team/game.git");
        JsonObject response = JsonParser.parseString("{\"data\":[],\"nextCursor\":\"next-page\",\"hasMore\":true}").getAsJsonObject();
        for (String path : new String[]{project.resolve("src").toString(), clone.toString(), tmp.getRoot().toString()}) {
            JsonObject thread = new JsonObject();thread.addProperty("cwd", path);response.getAsJsonArray("data").add(thread);
        }
        JsonObject filtered = new GitRepositorySessionMatcher(project.toString()).filterNativeThreads(response, project.toString());
        assertEquals(2, filtered.getAsJsonArray("data").size());
        assertEquals("next-page", filtered.get("nextCursor").getAsString());
        assertTrue(filtered.get("hasMore").getAsBoolean());
        assertEquals(3, response.getAsJsonArray("data").size());
        assertEquals(1, new GitRepositorySessionMatcher(null).filterNativeThreads(response, project.toString()).getAsJsonArray("data").size());
    }

    @Test public void recognizesRepositoriesThroughExtendedWindowsPaths() throws Exception {
        org.junit.Assume.assumeTrue(java.io.File.separatorChar == '\\');
        Path project = create(tmp.getRoot().toPath().resolve("current"), "https://host/team/game.git");
        Path clone = create(tmp.getRoot().toPath().resolve("clone"), "https://host/team/game.git");
        String extendedProject = "\\\\?\\" + project;
        String extendedClone = "\\\\?\\" + clone;
        GitRepositorySessionMatcher matcher = new GitRepositorySessionMatcher(extendedProject);
        assertTrue(matcher.hasRepository());
        assertTrue(matcher.test(extendedClone));
        assertTrue(matcher.test(extendedClone.replace('\\', '/')));
    }

    @Test public void matchesExtendedWindowsCwdWithoutGitAndKeepsDirectoryBoundaries() {
        JsonObject response = JsonParser.parseString("{\"data\":[]}").getAsJsonObject();
        for (String path : new String[]{"\\\\?\\C:\\Project\\Repo", "//?/c:/project/repo/child",
                "\\\\?\\C:\\Project\\Repository"}) {
            JsonObject thread = new JsonObject();thread.addProperty("cwd", path);response.getAsJsonArray("data").add(thread);
        }
        GitRepositorySessionMatcher matcher = new GitRepositorySessionMatcher(null);
        assertEquals(2, matcher.filterNativeThreads(response, "C:/PROJECT/REPO/").getAsJsonArray("data").size());
        assertEquals(2, matcher.filterNativeThreads(response, "\\\\?\\C:\\Project\\Repo").getAsJsonArray("data").size());
    }

    @Test public void matchesExtendedUncCwdWithoutGit() {
        JsonObject response = JsonParser.parseString("{\"data\":[]}").getAsJsonObject();
        for (String path : new String[]{"\\\\?\\UNC\\Server\\Share\\Repo", "//?/unc/server/share/repo/child",
                "\\\\?\\UNC\\Other\\Share\\Repo", "//server/share/repository"}) {
            JsonObject thread = new JsonObject();thread.addProperty("cwd", path);response.getAsJsonArray("data").add(thread);
        }
        GitRepositorySessionMatcher matcher = new GitRepositorySessionMatcher(null);
        assertEquals(2, matcher.filterNativeThreads(response, "//SERVER/SHARE/REPO/").getAsJsonArray("data").size());
        assertEquals(2, matcher.filterNativeThreads(response, "\\\\?\\UNC\\Server\\Share\\Repo").getAsJsonArray("data").size());
    }
}
