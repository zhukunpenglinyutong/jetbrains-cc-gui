package com.github.claudecodegui.bridge;

import com.github.claudecodegui.session.runtime.RuntimeKey;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class ProcessManagerRuntimeKeyTest {

    @Test
    public void registersAndUnregistersRuntimeProcessWithoutTouchingChannelProcess() {
        ProcessManager manager = new ProcessManager();
        Process fakeProcess = new FakeProcess();
        RuntimeKey key = new RuntimeKey("claude", "channel-a", "tab-a", "epoch-a");

        manager.registerProcess(key, fakeProcess);

        assertSame(fakeProcess, manager.getProcess(key));
        assertFalse(manager.wasInterrupted(key));

        manager.unregisterProcess(key, fakeProcess);

        assertFalse(manager.wasInterrupted(key));
    }

    @Test
    public void cleanupTabOnlyRemovesMatchingRuntimeKeys() {
        ProcessManager manager = new ProcessManager();
        RuntimeKey tabA = new RuntimeKey("claude", "channel-a", "tab-a", "epoch-a");
        RuntimeKey tabB = new RuntimeKey("claude", "channel-b", "tab-b", "epoch-b");
        FakeProcess processA = new FakeProcess(false);
        FakeProcess processB = new FakeProcess(false);

        manager.registerProcess(tabA, processA);
        manager.registerProcess(tabB, processB);

        manager.cleanupTab("tab-a");

        assertFalse(processB.destroyed);
        assertFalse(manager.wasInterrupted(tabA));
        assertSame(processB, manager.getProcess(tabB));
    }

    private static class FakeProcess extends Process {
        private boolean alive = true;
        private boolean destroyed = false;

        FakeProcess() {
        }

        FakeProcess(boolean alive) {
            this.alive = alive;
        }

        @Override
        public java.io.OutputStream getOutputStream() {
            return java.io.OutputStream.nullOutputStream();
        }

        @Override
        public java.io.InputStream getInputStream() {
            return java.io.InputStream.nullInputStream();
        }

        @Override
        public java.io.InputStream getErrorStream() {
            return java.io.InputStream.nullInputStream();
        }

        @Override
        public int waitFor() {
            alive = false;
            return 0;
        }

        @Override
        public boolean waitFor(long timeout, java.util.concurrent.TimeUnit unit) {
            alive = false;
            return true;
        }

        @Override
        public int exitValue() {
            return 0;
        }

        @Override
        public void destroy() {
            destroyed = true;
            alive = false;
        }

        @Override
        public Process destroyForcibly() {
            destroy();
            return this;
        }

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public long pid() {
            return ProcessHandle.current().pid();
        }
    }
}
