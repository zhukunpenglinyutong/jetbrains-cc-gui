package com.github.claudecodegui.bridge;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/** Checks that channel bookkeeping cannot release an OS process's migration exclusion. */
public class ProcessManagerPermitTest {
    @Test
    @SuppressWarnings("unchecked")
    public void unregisteringALiveProcessKeepsItsMigrationPermitUntilExit() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataProcessGate.ProcessPermit permit = gate.acquireProcessPermit();
        ProcessManager manager = new ProcessManager();
        ControlledProcess process = new ControlledProcess();
        Field field = ProcessManager.class.getDeclaredField("processPermits");
        field.setAccessible(true);
        ((Map<Process, AiDataProcessGate.ProcessPermit>) field.get(manager)).put(process, permit);
        manager.registerProcess("fixture", process);
        try {
            manager.unregisterProcess("fixture", process);
            assertNull(manager.getProcess("fixture"));
            AiDataProcessGate.MigrationPermit premature = gate.tryAcquireMigrationPermit();
            try {
                assertNull("A removed channel may still have a live process", premature);
            } finally {
                if (premature != null) {
                    premature.close();
                }
            }
            process.destroy();
            try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit()) {
                assertNotNull(migration);
            }
        } finally {
            process.destroy();
            permit.close();
        }
    }

    private static final class ControlledProcess extends Process {
        private final CompletableFuture<Process> exit = new CompletableFuture<>();

        @Override
        public OutputStream getOutputStream() {
            return new ByteArrayOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public InputStream getErrorStream() {
            return new ByteArrayInputStream(new byte[0]);
        }

        @Override
        public int waitFor() {
            exit.join();
            return 0;
        }

        @Override
        public int exitValue() {
            if (!exit.isDone()) {
                throw new IllegalThreadStateException("Fixture is still alive");
            }
            return 0;
        }

        @Override
        public boolean isAlive() {
            return !exit.isDone();
        }

        @Override
        public CompletableFuture<Process> onExit() {
            return exit;
        }

        @Override
        public void destroy() {
            exit.complete(this);
        }
    }
}
