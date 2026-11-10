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

    private final List<Project> notices = new ArrayList<>();
    private final List<Project> outside = new ArrayList<>();

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
        return project(null);
    }

    private static Project project(String basePath) {
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
                        case "getBasePath":
                            return basePath;
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

    private static final List<ProjectTrust.TrustLookup> TRUSTING = List.of(lookup("TrustingNewApi", "isProjectTrusted"));

    @Test
    public void aTrustedProjectTrustsItsOwnDirectoryAndSubdirectories() throws Exception {
        java.io.File base = java.nio.file.Files.createTempDirectory("ccgui-trust").toFile();
        java.io.File nested = new java.io.File(base, "src");
        assertTrue(nested.mkdirs());
        try {
            Project project = project(base.getPath());
            assertTrue(ProjectTrust.isTrustedForClaude(project, base.getPath(), TRUSTING, notices::add, outside::add));
            assertTrue(ProjectTrust.isTrustedForClaude(project, nested.getPath(), TRUSTING, notices::add, outside::add));
            assertTrue(ProjectTrust.isTrustedForClaude(project, "", TRUSTING, notices::add, outside::add));
            assertTrue(notices.isEmpty());
            assertTrue(outside.isEmpty());
        } finally {
            nested.delete();
            base.delete();
        }
    }

    @Test
    public void aTrustedWslProjectTrustsItsUncSubdirectoriesButNotOtherUncPaths() {
        Project project = project("//wsl.localhost/Ubuntu/home/alice/proj");
        assertTrue(ProjectTrust.isTrustedForClaude(project, "//wsl.localhost/Ubuntu/home/alice/proj", TRUSTING, notices::add, outside::add));
        assertTrue(ProjectTrust.isTrustedForClaude(project, "\\\\wsl.localhost\\Ubuntu\\home\\alice\\proj\\src", TRUSTING, notices::add, outside::add));
        assertTrue(outside.isEmpty());

        assertFalse(ProjectTrust.isTrustedForClaude(project, "//wsl.localhost/Ubuntu/home/alice/other", TRUSTING, notices::add, outside::add));
        assertFalse(ProjectTrust.isTrustedForClaude(project, "//wsl.localhost/Ubuntu/home/alice/proj-other", TRUSTING, notices::add, outside::add));
        assertFalse(ProjectTrust.isTrustedForClaude(project, "//wsl.localhost/Ubuntu/home/alice/proj/../other", TRUSTING, notices::add, outside::add));
        assertEquals(List.of(project), outside);
    }

    @Test
    public void aTrustedProjectDoesNotTrustAWorkingDirectoryOutsideIt() throws Exception {
        java.io.File base = java.nio.file.Files.createTempDirectory("ccgui-trust-base").toFile();
        java.io.File other = java.nio.file.Files.createTempDirectory("ccgui-trust-other").toFile();
        try {
            Project project = project(base.getPath());
            assertFalse(ProjectTrust.isTrustedForClaude(project, other.getPath(), TRUSTING, notices::add, outside::add));
            assertEquals(List.of(project), outside);
            assertTrue(notices.isEmpty());
        } finally {
            base.delete();
            other.delete();
        }
    }

    @Test
    public void theOutsideWorkingDirectoryNoticeIsShownOncePerProject() throws Exception {
        java.io.File base = java.nio.file.Files.createTempDirectory("ccgui-trust-base").toFile();
        java.io.File other = java.nio.file.Files.createTempDirectory("ccgui-trust-other").toFile();
        try {
            Project project = project(base.getPath());
            ProjectTrust.isTrustedForClaude(project, other.getPath(), TRUSTING, notices::add, outside::add);
            ProjectTrust.isTrustedForClaude(project, other.getPath(), TRUSTING, notices::add, outside::add);
            assertEquals(List.of(project), outside);
        } finally {
            base.delete();
            other.delete();
        }
    }

    @Test
    public void anUntrustedProjectStaysUntrustedWhateverTheWorkingDirectory() throws Exception {
        java.io.File base = java.nio.file.Files.createTempDirectory("ccgui-trust-base").toFile();
        try {
            Project project = project(base.getPath());
            List<ProjectTrust.TrustLookup> distrusting = List.of(lookup("DistrustingNewApi", "isProjectTrusted"));
            assertFalse(ProjectTrust.isTrustedForClaude(project, base.getPath(), distrusting, notices::add, outside::add));
            assertEquals(List.of(project), notices);
            assertTrue(outside.isEmpty());
        } finally {
            base.delete();
        }
    }

    @Test
    public void aProjectWithoutABasePathTrustsNoWorkingDirectory() {
        assertFalse(ProjectTrust.isTrustedForClaude(project(null), "/work", TRUSTING, notices::add, outside::add));
    }

    public static class StaticConfirmingDialog {
        public static boolean confirmLoadingUntrustedProject(Project project, String title, String message, String trust, String distrust) {
            return "Trust".equals(trust) && "Stay".equals(distrust) && "Title".equals(title) && "Message".equals(message);
        }
    }

    public static class DecliningDialog {
        public static boolean confirmLoadingUntrustedProject(Project project, String title, String message, String trust, String distrust) {
            return false;
        }
    }

    public static class ThrowingDialog {
        public static boolean confirmLoadingUntrustedProject(Project project, String title, String message, String trust, String distrust) {
            throw new IllegalStateException("dialog unavailable");
        }
    }

    public static class InstanceDialog {
        public static final InstanceDialog INSTANCE = new InstanceDialog();

        public boolean confirmLoadingUntrustedProject(Project project, String title, String message, String trust, String distrust) {
            return true;
        }
    }

    public static class InstanceDialogWithoutInstance {
        public boolean confirmLoadingUntrustedProject(Project project, String title, String message, String trust, String distrust) {
            return true;
        }
    }

    private static ProjectTrust.ConfirmLookup confirm(String simpleName) {
        return new ProjectTrust.ConfirmLookup(PREFIX + simpleName, "confirmLoadingUntrustedProject");
    }

    private static boolean request(List<ProjectTrust.ConfirmLookup> lookups) {
        return ProjectTrust.requestTrust(project(), lookups, "Title", "Message", "Trust", "Stay");
    }

    @Test
    public void theTrustRequestPassesTheDialogTextAndReturnsTheAnswer() {
        assertTrue(request(List.of(confirm("StaticConfirmingDialog"))));
        assertFalse(request(List.of(confirm("DecliningDialog"))));
    }

    @Test
    public void theTrustRequestUsesAnInstanceMethodThroughItsInstanceField() {
        assertTrue(request(List.of(confirm("InstanceDialog"))));
        assertFalse(request(List.of(confirm("InstanceDialogWithoutInstance"))));
    }

    @Test
    public void theTrustRequestFallsBackToTheNextDialogAndFailsClosed() {
        assertTrue(request(List.of(new ProjectTrust.ConfirmLookup("com.example.DoesNotExist", "confirmLoadingUntrustedProject"),
                confirm("StaticConfirmingDialog"))));
        assertFalse(request(List.of(confirm("ThrowingDialog"))));
        assertFalse(request(List.of()));
        assertFalse(ProjectTrust.requestTrust(null, List.of(confirm("StaticConfirmingDialog")), "Title", "Message", "Trust", "Stay"));
    }

    @Test
    public void aDialogIsOnlyOfferedWhenOneResolves() {
        assertNotNull(ProjectTrust.resolveConfirmation(List.of(confirm("StaticConfirmingDialog"))));
        assertEquals(null, ProjectTrust.resolveConfirmation(List.of(confirm("InstanceDialogWithoutInstance"))));
    }
}
