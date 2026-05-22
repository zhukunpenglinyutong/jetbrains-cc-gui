package com.github.claudecodegui.action.vcs;

import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.vcs.CommitMessageI;
import org.junit.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class GenerateCommitMessageActionTest {

    @Test
    public void shouldCancelWorkerOnlyOnceWhenCancelledConcurrently() throws Exception {
        GenerateCommitMessageAction action = new GenerateCommitMessageAction();
        Object session = newGenerationSession(action);
        CountingFuture worker = new CountingFuture();
        Field workerField = session.getClass().getDeclaredField("worker");
        workerField.setAccessible(true);
        workerField.set(session, worker);

        Method cancel = session.getClass().getDeclaredMethod("cancel", boolean.class);
        cancel.setAccessible(true);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        Runnable task = () -> {
            ready.countDown();
            try {
                start.await(5, TimeUnit.SECONDS);
                cancel.invoke(session, false);
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        };

        Thread first = new Thread(task);
        Thread second = new Thread(task);
        first.start();
        second.start();
        assertTrue(ready.await(5, TimeUnit.SECONDS));
        start.countDown();
        first.join();
        second.join();

        assertEquals(1, worker.cancelCalls.get());
    }

    private Object newGenerationSession(GenerateCommitMessageAction action) throws Exception {
        Class<?> sessionClass = Class.forName(
                "com.github.claudecodegui.action.vcs.GenerateCommitMessageAction$GenerationSession"
        );
        Constructor<?> constructor = sessionClass.getDeclaredConstructor(
                GenerateCommitMessageAction.class,
                String.class,
                com.intellij.openapi.project.Project.class,
                CommitMessageI.class,
                Presentation.class,
                String.class
        );
        constructor.setAccessible(true);
        return constructor.newInstance(
                action,
                "test-project",
                null,
                (CommitMessageI) message -> {
                },
                new Presentation(),
                "original"
        );
    }

    private static final class CountingFuture implements Future<Object> {
        private final AtomicInteger cancelCalls = new AtomicInteger();

        @Override
        public boolean cancel(boolean mayInterruptIfRunning) {
            cancelCalls.incrementAndGet();
            return true;
        }

        @Override
        public boolean isCancelled() {
            return cancelCalls.get() > 0;
        }

        @Override
        public boolean isDone() {
            return isCancelled();
        }

        @Override
        public Object get() {
            return null;
        }

        @Override
        public Object get(long timeout, TimeUnit unit) {
            return null;
        }
    }
}
