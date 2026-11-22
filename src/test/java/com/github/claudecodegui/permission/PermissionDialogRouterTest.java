package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

public class PermissionDialogRouterTest {

    @Test
    public void externalContentRootRoutesToOwningProjectInsteadOfLastActiveProject() {
        Project projectA = project("A", "/projects/a");
        Project projectB = project("B", "/projects/b");
        Map<Project, List<String>> boundaries = new IdentityHashMap<>();
        boundaries.put(projectA, List.of("/projects/a", "/attached/a"));
        boundaries.put(projectB, List.of("/projects/b"));
        PermissionDialogRouter router = router(boundaries, projectA, projectB);
        PermissionService.PermissionDialogShower showerA = (toolName, inputs) -> null;
        PermissionService.PermissionDialogShower showerB = (toolName, inputs) -> null;
        router.registerPermissionDialogShower(projectA, showerA);
        router.registerPermissionDialogShower(projectB, showerB);
        router.setLastActiveProject(projectB);

        JsonObject request = request("/attached/a/module");

        assertSame(showerA, router.findPermissionDialogShower(request, "TEST"));
        assertSame(projectA, router.findProjectByCwd(request));
        assertSame(projectA, router.findProjectByPath(request));
    }

    @Test
    public void basePathRoutingAndPreferredProjectFallbackArePreserved() {
        Project projectA = project("A", "/projects/a");
        Project projectB = project("B", "/projects/b");
        Map<Project, List<String>> boundaries = new IdentityHashMap<>();
        boundaries.put(projectA, List.of("/projects/a"));
        boundaries.put(projectB, List.of("/projects/b"));
        PermissionDialogRouter router = router(boundaries, projectA, projectB);
        PermissionService.PermissionDialogShower showerA = (toolName, inputs) -> null;
        PermissionService.PermissionDialogShower showerB = (toolName, inputs) -> null;
        router.registerPermissionDialogShower(projectA, showerA);
        router.registerPermissionDialogShower(projectB, showerB);
        router.setLastActiveProject(projectB);

        JsonObject baseRequest = request("/projects/a/src");
        assertSame(showerA, router.findPermissionDialogShower(baseRequest, "TEST"));
        assertSame(projectA, router.findProjectByPath(baseRequest));

        JsonObject unrelatedRequest = request("/unrelated/src");
        assertSame(showerB, router.findPermissionDialogShower(unrelatedRequest, "TEST"));
        assertSame(projectB, router.findProjectByCwd(unrelatedRequest));
        assertNull(router.findProjectByPath(unrelatedRequest));
    }

    @Test
    public void longestContentRootWinsWhenProjectBoundariesNest() {
        Project projectA = project("A", "/projects/a");
        Project projectB = project("B", "/shared");
        Map<Project, List<String>> boundaries = new IdentityHashMap<>();
        boundaries.put(projectA, List.of("/projects/a", "/shared/nested"));
        boundaries.put(projectB, List.of("/shared"));
        PermissionDialogRouter router = router(boundaries, projectA, projectB);
        PermissionService.PermissionDialogShower showerA = (toolName, inputs) -> null;
        PermissionService.PermissionDialogShower showerB = (toolName, inputs) -> null;
        router.registerPermissionDialogShower(projectA, showerA);
        router.registerPermissionDialogShower(projectB, showerB);
        router.setLastActiveProject(projectB);

        JsonObject request = request("/shared/nested/module");

        assertSame(showerA, router.findPermissionDialogShower(request, "TEST"));
        assertSame(projectA, router.findProjectByPath(request));
    }

    private static PermissionDialogRouter router(
            Map<Project, List<String>> boundaries,
            Project... openProjects
    ) {
        return new PermissionDialogRouter((prefix, message) -> { }) {
            @Override
            Project[] getOpenProjects() {
                return openProjects;
            }

            @Override
            List<String> getProjectBoundaryPaths(Project project) {
                return boundaries.getOrDefault(project, List.of());
            }
        };
    }

    private static Project project(String name, String basePath) {
        return (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getName" -> name;
                    case "getBasePath" -> basePath;
                    case "isDisposed" -> false;
                    case "hashCode" -> System.identityHashCode(proxy);
                    case "equals" -> proxy == args[0];
                    case "toString" -> name;
                    default -> null;
                }
        );
    }

    private static JsonObject request(String cwd) {
        JsonObject request = new JsonObject();
        request.addProperty("cwd", cwd);
        return request;
    }
}
