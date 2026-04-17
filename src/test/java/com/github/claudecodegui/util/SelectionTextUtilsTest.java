package com.github.claudecodegui.util;

import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.junit.After;
import org.junit.Assert;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

public class SelectionTextUtilsTest {

    private Project testProject;

    @Before
    public void setUp() {
        SelectionTextUtils.resetTestHooks();
        testProject = createDummyProject();
    }

    @After
    public void tearDown() {
        SelectionTextUtils.resetTestHooks();
    }

    @Test
    public void normalizeSendableText_returnsNullWhenTextIsNull() {
        Assert.assertNull(SelectionTextUtils.normalizeSendableText(null));
    }

    @Test
    public void normalizeSendableText_returnsNullForBlankInput() {
        Assert.assertNull(SelectionTextUtils.normalizeSendableText("   "));
    }

    @Test
    public void normalizeSendableText_keepsOriginalForContent() {
        String original = "  keep me  ";
        Assert.assertEquals(original, SelectionTextUtils.normalizeSendableText(original));
    }

    @Test
    public void sendToChatWindow_reportsErrorWhenWindowMissing() {
        AtomicInteger errorCount = new AtomicInteger();
        SelectionTextUtils.setToolWindowProvider(project -> null);
        SelectionTextUtils.setErrorNotifier((project, message) -> errorCount.incrementAndGet());

        SelectionTextUtils.sendToChatWindow(testProject, "payload");

        Assert.assertEquals(1, errorCount.get());
    }

    @Test
    public void sendToChatWindow_sendsDirectlyWhenWindowVisible() {
        AtomicInteger activateCount = new AtomicInteger();
        AtomicInteger sendCount = new AtomicInteger();
        SelectionTextUtils.setToolWindowProvider(project -> new TestToolWindowProxy(true, (runnable, autoFocus) -> {
            activateCount.incrementAndGet();
        }));
        SelectionTextUtils.setChatInputSender((project, text) -> sendCount.incrementAndGet());
        SelectionTextUtils.setScheduler((runnable, delayMs) -> {
            Assert.fail("Scheduler should not run when window is visible");
        });

        SelectionTextUtils.sendToChatWindow(testProject, "payload");

        Assert.assertEquals(0, activateCount.get());
        Assert.assertEquals(1, sendCount.get());
    }

    @Test
    public void sendToChatWindow_activatesThenSchedulesWhenWindowHidden() {
        AtomicBoolean schedulerRan = new AtomicBoolean();
        AtomicInteger sendCount = new AtomicInteger();
        AtomicInteger activateCount = new AtomicInteger();

        SelectionTextUtils.setToolWindowProvider(project -> new TestToolWindowProxy(false, (runnable, autoFocus) -> {
            activateCount.incrementAndGet();
            runnable.run();
        }));
        SelectionTextUtils.setScheduler((runnable, delayMs) -> {
            schedulerRan.set(true);
            runnable.run();
        });
        SelectionTextUtils.setChatInputSender((project, text) -> sendCount.incrementAndGet());

        SelectionTextUtils.sendToChatWindow(testProject, "payload");

        Assert.assertTrue(schedulerRan.get());
        Assert.assertEquals(1, activateCount.get());
        Assert.assertEquals(1, sendCount.get());
    }

    private static Project createDummyProject() {
        InvocationHandler handler = new InvocationHandler() {
            @Override
            public Object invoke(Object proxy, Method method, Object[] args) {
                String name = method.getName();
                if ("isDisposed".equals(name)) {
                    return false;
                }
                if ("equals".equals(name)) {
                    return proxy == args[0];
                }
                if ("hashCode".equals(name)) {
                    return System.identityHashCode(proxy);
                }
                if ("toString".equals(name)) {
                    return "test-project";
                }
                Class<?> returnType = method.getReturnType();
                if (returnType.isPrimitive()) {
                    if (returnType == boolean.class) {
                        return false;
                    }
                    if (returnType == int.class) {
                        return 0;
                    }
                    if (returnType == long.class) {
                        return 0L;
                    }
                    if (returnType == double.class) {
                        return 0.0d;
                    }
                    if (returnType == float.class) {
                        return 0f;
                    }
                    if (returnType == short.class) {
                        return (short) 0;
                    }
                    if (returnType == byte.class) {
                        return (byte) 0;
                    }
                    if (returnType == char.class) {
                        return '\u0000';
                    }
                }
                return null;
            }
        };
        return (Project) Proxy.newProxyInstance(Project.class.getClassLoader(), new Class[]{Project.class}, handler);
    }

    private static final class TestToolWindowProxy implements SelectionTextUtils.ToolWindowProxy {
        private final boolean visible;
        private final ActivateHandler handler;

        private interface ActivateHandler {
            void run(@NotNull Runnable runnable, boolean autoFocus);
        }

        private TestToolWindowProxy(boolean visible, ActivateHandler handler) {
            this.visible = visible;
            this.handler = handler;
        }

        @Override
        public boolean isVisible() {
            return visible;
        }

        @Override
        public void activate(@NotNull Runnable runnable, boolean autoFocus) {
            handler.run(runnable, autoFocus);
        }
    }
}
