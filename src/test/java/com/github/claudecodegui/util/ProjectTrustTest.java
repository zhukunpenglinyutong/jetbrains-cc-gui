package com.github.claudecodegui.util;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Key;
import org.junit.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class ProjectTrustTest {

    public static class TrustingNewApi {
        public static boolean isProjectTrusted(Project project) {
            return true;
        }
    }

    public static class DistrustingNewApi {
        public static boolean isProjectTrusted(Project project) {
            return false;
        }
    }

    public static class TrustingOldApi {
        public static boolean isTrusted(Project project) {
            return true;
        }
    }

    public static class ThrowingApi {
        public static boolean isProjectTrusted(Project project) {
            throw new IllegalStateException("trust service unavailable");
        }
    }

    public static class InstanceOnlyApi {
        public boolean isProjectTrusted(Project project) {
            return true;
        }
    }

    private static final String PREFIX = ProjectTrustTest.class.getName() + "$";

    private static ProjectTrust.TrustLookup lookup(String simpleName, String method) {
        return new ProjectTrust.TrustLookup(PREFIX + simpleName, method);
    }

    private static Project project() {
        Map<Key<?>, Object> userData = new HashMap<>();
        return (Project) Proxy.newProxyInstance(
                ProjectTrustTest.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getUserData":
                            return userData.get(args[0]);
                        case "putUserData":
                            userData.put((Key<?>) args[0], args[1]);
                            return null;
                        case "isDisposed":
                            return false;
                        case "hashCode":
                            return System.identityHashCode(proxy);
                        case "equals":
                            return proxy == args[0];
                        case "toString":
                            return "test project";
                        default:
                            return null;
                    }
                });
    }

    @Test
    public void usesTheFirstAvailableTrustApi() {
        assertTrue(ProjectTrust.isTrusted(project(), List.of(lookup("TrustingNewApi", "isProjectTrusted"), lookup("DistrustingNewApi", "isProjectTrusted"))));
        assertFalse(ProjectTrust.isTrusted(project(), List.of(lookup("DistrustingNewApi", "isProjectTrusted"), lookup("TrustingOldApi", "isTrusted"))));
    }

    @Test
    public void fallsBackToTheOlderApiWhenTheNewerOneIsMissing() {
        assertTrue(ProjectTrust.isTrusted(project(), List.of(
                new ProjectTrust.TrustLookup("com.example.DoesNotExist", "isProjectTrusted"),
                lookup("TrustingNewApi", "noSuchMethod"),
                lookup("InstanceOnlyApi", "isProjectTrusted"),
                lookup("TrustingOldApi", "isTrusted"))));
    }

    @Test
    public void isUntrustedWhenNoApiIsAvailable() {
        assertFalse(ProjectTrust.isTrusted(project(), List.of(new ProjectTrust.TrustLookup("com.example.DoesNotExist", "isTrusted"))));
        assertFalse(ProjectTrust.isTrusted(project(), List.of()));
    }

    @Test
    public void isUntrustedWhenTheTrustCheckFails() {
        assertFalse(ProjectTrust.isTrusted(project(), List.of(lookup("ThrowingApi", "isProjectTrusted"), lookup("TrustingOldApi", "isTrusted"))));
    }

    @Test
    public void aMissingProjectIsUntrusted() {
        assertFalse(ProjectTrust.isTrusted(null, List.of(lookup("TrustingNewApi", "isProjectTrusted"))));
    }

    @Test
    public void theBuiltInLookupsResolveAgainstThePlatformApi() {
        Method method = ProjectTrust.resolveTrustMethod(ProjectTrust.LOOKUPS);
        assertNotNull(method);
        assertEquals(boolean.class, method.getReturnType());
    }

    @Test
    public void theUntrustedNoticeIsShownOncePerProject() {
        Project first = project();
        Project second = project();
        List<Project> notices = new ArrayList<>();
        List<ProjectTrust.TrustLookup> distrusting = List.of(lookup("DistrustingNewApi", "isProjectTrusted"));

        assertFalse(ProjectTrust.isTrustedForClaude(first, distrusting, notices::add));
        assertFalse(ProjectTrust.isTrustedForClaude(first, distrusting, notices::add));
        assertFalse(ProjectTrust.isTrustedForClaude(second, distrusting, notices::add));

        assertEquals(List.of(first, second), notices);
    }

    @Test
    public void aTrustedProjectShowsNoNotice() {
        List<Project> notices = new ArrayList<>();
        assertTrue(ProjectTrust.isTrustedForClaude(project(), List.of(lookup("TrustingNewApi", "isProjectTrusted")), notices::add));
        assertTrue(notices.isEmpty());
    }
}
