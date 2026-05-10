package com.github.claudecodegui.handler.context;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Method;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Test for WorkspaceContextCollector.
 * Tests the workspace context collection functionality for multi-project support.
 */
public class WorkspaceContextCollectorTest {

    /**
     * Test that collectWorkspaceContext returns empty JSON for null project.
     */
    @Test
    public void collectWorkspaceContextReturnsEmptyForNullProject() {
        JsonObject result = WorkspaceContextCollector.collectWorkspaceContext(null);

        assertNotNull(result);
        assertEquals(0, result.size());
    }

    /**
     * Test that getSubprojectForFile returns null when project is null.
     */
    @Test
    public void getSubprojectForFileReturnsNullForNullProject() {
        assertNull(WorkspaceContextCollector.getSubprojectForFile(null, "/some/path"));
    }

    /**
     * Test that getSubprojectForFile returns null when file path is null.
     */
    @Test
    public void getSubprojectForFileReturnsNullForNullPath() {
        assertNull(WorkspaceContextCollector.getSubprojectForFile(null, null));
    }

    /**
     * Test that static methods produce consistent results across multiple calls.
     */
    @Test
    public void staticMethodsProduceConsistentResults() {
        JsonObject result1 = WorkspaceContextCollector.collectWorkspaceContext(null);
        JsonObject result2 = WorkspaceContextCollector.collectWorkspaceContext(null);

        assertEquals(result1.size(), result2.size());
        assertEquals(0, result1.size());
    }

    /**
     * Test extractSubprojectNameFromPath with normal paths.
     */
    @Test
    public void extractSubprojectNameFromNormalPath() throws Exception {
        String name = invokeExtractName("/home/user/projects/my-app");
        assertEquals("my-app", name);
    }

    /**
     * Test extractSubprojectNameFromPath with trailing slash.
     */
    @Test
    public void extractSubprojectNameFromPathWithTrailingSlash() throws Exception {
        String name = invokeExtractName("/home/user/projects/my-app/");
        assertEquals("my-app", name);
    }

    /**
     * Test extractSubprojectNameFromPath with simple name (no slash).
     */
    @Test
    public void extractSubprojectNameFromSimpleName() throws Exception {
        String name = invokeExtractName("my-app");
        assertEquals("my-app", name);
    }

    /**
     * Test extractSubprojectNameFromPath with multiple trailing slashes.
     * All trailing slashes should be trimmed before taking the last segment.
     */
    @Test
    public void extractSubprojectNameFromPathWithMultipleTrailingSlashes() throws Exception {
        String name = invokeExtractName("/home/user/projects/my-app//");
        assertEquals("my-app", name);
    }

    /**
     * Test that extractSubprojectNameFromPath returns null for an all-slashes path.
     */
    @Test
    public void extractSubprojectNameFromAllSlashes() throws Exception {
        String name = invokeExtractName("///");
        assertNull(name);
    }

    /**
     * Test that null project results in a JSON object without an isWorkspace key.
     */
    @Test
    public void nullProjectProducesEmptyContextWithoutIsWorkspaceKey() {
        JsonObject result = WorkspaceContextCollector.collectWorkspaceContext(null);
        assertNotNull(result);
        assertFalse(result.has("isWorkspace"));
    }

    private static String invokeExtractName(String path) throws Exception {
        Method method = WorkspaceContextCollector.class.getDeclaredMethod(
            "extractSubprojectNameFromPath", String.class);
        method.setAccessible(true);
        return (String) method.invoke(null, path);
    }
}
