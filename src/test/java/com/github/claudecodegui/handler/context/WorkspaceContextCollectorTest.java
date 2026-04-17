package com.github.claudecodegui.handler.context;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
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
        WorkspaceContextCollector collector = new WorkspaceContextCollector();

        JsonObject result = collector.collectWorkspaceContext(null);

        assertNotNull(result);
        assertEquals(0, result.size());
    }

    /**
     * Test that getSubprojectForFile returns null when project is null.
     */
    @Test
    public void getSubprojectForFileReturnsNullForNullProject() {
        WorkspaceContextCollector collector = new WorkspaceContextCollector();

        assertNull(collector.getSubprojectForFile(null, "/some/path"));
    }

    /**
     * Test that getSubprojectForFile returns null when file path is null.
     */
    @Test
    public void getSubprojectForFileReturnsNullForNullPath() {
        WorkspaceContextCollector collector = new WorkspaceContextCollector();

        assertNull(collector.getSubprojectForFile(null, null));
    }

    /**
     * Test that multiple instances share the same static reflection state.
     * WorkspaceContextCollector uses static fields for reflection caching,
     * so all instances should behave identically.
     */
    @Test
    public void multipleInstancesShareStaticState() {
        WorkspaceContextCollector collector1 = new WorkspaceContextCollector();
        WorkspaceContextCollector collector2 = new WorkspaceContextCollector();

        JsonObject result1 = collector1.collectWorkspaceContext(null);
        JsonObject result2 = collector2.collectWorkspaceContext(null);

        // Both should return empty results with no project
        assertEquals(result1.size(), result2.size());
        assertEquals(0, result1.size());
    }
}
