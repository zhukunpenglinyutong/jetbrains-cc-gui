package com.github.claudecodegui.handler;

import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class TabHandlerTest {

    @Test
    public void isAuthorizedForkSourceSessionIdRequiresCurrentSessionMatch() {
        assertTrue(TabHandler.isAuthorizedForkSourceSessionId("session-123", "session-123"));
        assertFalse(TabHandler.isAuthorizedForkSourceSessionId("session-123", "session-456"));
        assertFalse(TabHandler.isAuthorizedForkSourceSessionId("session-123", null));
    }

    @Test
    public void releaseReservedForkTitleRemovesEmptyProjectReservations() {
        Project project = createProject("project-a");

        TabHandler.addReservedForkTitle(project, "Title[fork]");
        TabHandler.releaseReservedForkTitle(project, "Title[fork]");

        assertEquals(Set.of(), TabHandler.getReservedForkTitlesSnapshot(project));
    }

    @Test
    public void isValidSourceSessionIdAcceptsUuidLikeSessionIds() {
        assertTrue(TabHandler.isValidSourceSessionId("550e8400-e29b-41d4-a716-446655440000"));
        assertTrue(TabHandler.isValidSourceSessionId("session_123-abc.def"));
    }

    @Test
    public void isValidSourceSessionIdRejectsPathTraversalAndControlCharacters() {
        assertFalse(TabHandler.isValidSourceSessionId("../550e8400-e29b-41d4-a716-446655440000"));
        assertFalse(TabHandler.isValidSourceSessionId("folder\\550e8400-e29b-41d4-a716-446655440000"));
        assertFalse(TabHandler.isValidSourceSessionId("550e8400-e29b-41d4-a716-446655440000\n"));
        assertFalse(TabHandler.isValidSourceSessionId("session id"));
        assertFalse(TabHandler.isValidSourceSessionId("session$123"));
        assertFalse(TabHandler.isValidSourceSessionId("a".repeat(129)));
        assertFalse(TabHandler.isValidSourceSessionId(""));
        assertFalse(TabHandler.isValidSourceSessionId(null));
    }

    @Test
    public void getInvalidSourceSessionIdMessageDistinguishesMissingFromInvalid() {
        assertEquals("无法从源会话 fork：缺少 sourceSessionId", TabHandler.getInvalidSourceSessionIdMessage(null));
        assertEquals("无法从源会话 fork：缺少 sourceSessionId", TabHandler.getInvalidSourceSessionIdMessage(""));
        assertEquals("无法从源会话 fork：sourceSessionId 无效", TabHandler.getInvalidSourceSessionIdMessage("../session"));
    }

    @Test
    public void reserveForkTitleUsesExistingReservationsBeforeAddingNewTitle() {
        Project project = createProject("project-reservation");

        String first = TabHandler.reserveForkTitle(project, "测试消息", Collections.emptyList());
        String second = TabHandler.reserveForkTitle(project, "测试消息", Collections.emptyList());

        assertEquals("测试消息[fork]", first);
        assertEquals("测试消息[fork 2]", second);
        assertEquals(Set.of(first, second), TabHandler.getReservedForkTitlesSnapshot(project));

        TabHandler.releaseReservedForkTitle(project, first);
        TabHandler.releaseReservedForkTitle(project, second);
        assertEquals(Set.of(), TabHandler.getReservedForkTitlesSnapshot(project));
    }

    @Test
    public void reserveForkTitleUsesReservationsForMissingSourceTitleFallback() {
        Project project = createProject("project-empty-title-reservation");

        String first = TabHandler.reserveForkTitle(project, "", Collections.emptyList());
        String second = TabHandler.reserveForkTitle(project, null, Collections.emptyList());

        assertEquals("[fork]", first);
        assertEquals("[fork 2]", second);
        assertEquals(Set.of(first, second), TabHandler.getReservedForkTitlesSnapshot(project));

        TabHandler.releaseReservedForkTitle(project, first);
        TabHandler.releaseReservedForkTitle(project, second);
    }

    private static Project createProject(String name) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[] { Project.class },
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getName":
                            return name;
                        case "isDisposed":
                            return false;
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        case "equals":
                            return proxy == args[0];
                        case "toString":
                            return name;
                        default:
                            return null;
                    }
                }
        );
    }
}
