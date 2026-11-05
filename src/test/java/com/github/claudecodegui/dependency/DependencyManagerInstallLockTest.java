package com.github.claudecodegui.dependency;

import org.junit.Test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import static org.junit.Assert.*;

public class DependencyManagerInstallLockTest {

    @Test public void aRunningInstallMakesTheNextOneGiveUpInsteadOfWaitingForever() throws Exception {
        ReentrantLock lock = DependencyManager.installLock(SdkDefinition.CLAUDE_SDK);
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread holder = new Thread(() -> {
            lock.lock();
            try {
                held.countDown();
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                lock.unlock();
            }
        });
        holder.start();
        try {
            assertTrue(held.await(5, TimeUnit.SECONDS));
            List<String> logs = new CopyOnWriteArrayList<>();
            long started = System.nanoTime();
            InstallResult result = new DependencyManager()
                    .installSdkSync(SdkDefinition.CLAUDE_SDK.getId(), null, logs::add, 300);
            assertFalse(result.isSuccess());
            assertTrue(result.getErrorMessage(), result.getErrorMessage().contains("still running"));
            assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 5);
            assertTrue(logs.stream().anyMatch(line -> line.startsWith("Waiting for another installation")));
        } finally {
            release.countDown();
            holder.join(5_000);
        }
    }
}
