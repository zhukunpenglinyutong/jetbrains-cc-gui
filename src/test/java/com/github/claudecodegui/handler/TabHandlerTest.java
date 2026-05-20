package com.github.claudecodegui.handler;

import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
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
