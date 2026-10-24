package com.github.claudecodegui.storage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.sql.Driver;
import java.sql.DriverManager;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexStorageDatabaseTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void pluginConnectionsDoNotDependOnDriverManagerDiscovery() throws Exception {
        var fixture = new CodexStorageFixture(temporary.newFolder().toPath());
        fixture.thread("visible", "/project", 10);
        List<Driver> drivers = DriverManager.drivers().filter(driver -> driver instanceof org.sqlite.JDBC).toList();
        assertTrue("Fixture must have initialized the native driver", !drivers.isEmpty());
        try {
            for (Driver driver : drivers) {
                DriverManager.deregisterDriver(driver);
            }
            try (var connection = CodexStorageDatabase.open(fixture.root.resolve("state_5.sqlite"), true)) {
                assertEquals(1L, CodexStorageDatabase.scalar(connection, "SELECT count(*) FROM threads"));
            }
            assertEquals(1, new CodexStorageInventory(fixture.paths).snapshot().sessions().size());
            assertTrue(fixture.service().databaseStatus().get("supported").getAsBoolean());
        } finally {
            for (Driver driver : drivers) {
                DriverManager.registerDriver(driver);
            }
        }
    }
}
