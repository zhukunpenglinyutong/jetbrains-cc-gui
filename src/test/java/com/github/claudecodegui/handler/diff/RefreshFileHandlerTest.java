package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class RefreshFileHandlerTest {
    /** Provides independent project and attached-root directories. */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** Resolves and freezes an attached-root file before a later directory switch. */
    @Test
    public void freezesAttachedRootRelativePathBeforeAsyncRefresh() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        Path other = this.temporary.newFolder("other").toPath();
        Path expected = attached.resolve("src/A.ts");
        HandlerContext context = this.context(base);
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setCwd(attached.toString());
        context.setSession(session);
        AtomicReference<String> refreshed = new AtomicReference<>();
        CountDownLatch refreshEntered = new CountDownLatch(1);
        CountDownLatch allowRefresh = new CountDownLatch(1);
        CountDownLatch refreshFinished = new CountDownLatch(1);
        RefreshFileHandler handler = new RefreshFileHandler(context, new Gson()) {
            @Override
            void refreshFile(String filePath) {
                refreshEntered.countDown();
                try {
                    if (allowRefresh.await(5, TimeUnit.SECONDS)) {
                        refreshed.set(filePath);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    refreshFinished.countDown();
                }
            }
        };

        handler.handle("refresh_file", "{\"filePath\":\"src/A.ts\"}");
        try {
            assertTrue("Refresh did not start", refreshEntered.await(5, TimeUnit.SECONDS));
            session.setCwd(other.toString());
        } finally {
            allowRefresh.countDown();
        }

        assertTrue("Refresh did not finish", refreshFinished.await(5, TimeUnit.SECONDS));
        assertEquals(expected.toString(), refreshed.get());
    }

    /** A refresh only rereads disk state, so files outside the project roots are refreshed too. */
    @Test
    public void refreshesFilesOutsideProjectRoots() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path outside = this.temporary.newFolder("outside").toPath().resolve("outside.ts");
        HandlerContext context = this.context(base);
        AtomicInteger refreshes = new AtomicInteger();
        AtomicReference<String> refreshed = new AtomicReference<>();
        CountDownLatch refreshFinished = new CountDownLatch(1);
        RefreshFileHandler handler = new RefreshFileHandler(context, new Gson()) {
            @Override
            void refreshFile(String filePath) {
                refreshes.incrementAndGet();
                refreshed.set(filePath);
                refreshFinished.countDown();
            }
        };
        JsonObject request = new JsonObject();
        request.addProperty("filePath", outside.toString());

        handler.handle("refresh_file", request.toString());

        assertTrue("Refresh did not finish", refreshFinished.await(5, TimeUnit.SECONDS));
        assertEquals(1, refreshes.get());
        assertEquals(outside.toString(), refreshed.get());
    }

    /** A relative request without either a session cwd or project base has no target. */
    @Test
    public void rejectsRelativePathWithoutWorkingDirectory() {
        HandlerContext context = this.context(null);
        AtomicInteger refreshes = new AtomicInteger();
        RefreshFileHandler handler = new RefreshFileHandler(context, new Gson()) {
            @Override
            void refreshFile(String filePath) {
                refreshes.incrementAndGet();
            }
        };

        handler.handle("refresh_file", "{\"filePath\":\"src/A.ts\"}");

        assertEquals(0, refreshes.get());
    }

    /** Absolute paths do not acquire a session or project-base prefix. */
    @Test
    public void keepsAbsolutePathWithoutWorkingDirectory() throws Exception {
        Path target = this.temporary.newFolder("absolute").toPath().resolve("src/A.ts");
        HandlerContext context = this.context(null);
        AtomicReference<String> refreshed = new AtomicReference<>();
        CountDownLatch refreshFinished = new CountDownLatch(1);
        RefreshFileHandler handler = new RefreshFileHandler(context, new Gson()) {
            @Override
            void refreshFile(String filePath) {
                refreshed.set(filePath);
                refreshFinished.countDown();
            }
        };
        JsonObject request = new JsonObject();
        request.addProperty("filePath", target.toString());

        handler.handle("refresh_file", request.toString());

        assertTrue("Refresh did not finish", refreshFinished.await(5, TimeUnit.SECONDS));
        assertEquals(target.toString(), refreshed.get());
    }

    /** Builds a minimal context without initializing IntelliJ's application or UI. */
    private HandlerContext context(Path basePath) {
        Project project = (Project) Proxy.newProxyInstance(Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> "getBasePath".equals(method.getName())
                        ? basePath == null ? null : basePath.toString() : null);
        return new HandlerContext(project, null, null, null, null);
    }
}
