package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OpenClassHandlerTest {

    @Test
    public void acceptsJavaFullyQualifiedClassNames() {
        assertTrue(OpenClassHandler.isValidClassName("com.github.foo.BarService"));
        assertTrue(OpenClassHandler.isValidClassName("com.github.foo.Outer.Inner"));
        assertTrue(OpenClassHandler.isValidClassName("com.github.claudecodegui.handler.file.OpenFileHandler"));
    }

    @Test
    public void rejectsInvalidClassExpressions() {
        // Member references (#) and method invocations (()) are still rejected.
        assertFalse(OpenClassHandler.isValidClassName("com.github.foo.Bar#baz"));
        assertFalse(OpenClassHandler.isValidClassName("com.github.foo.Bar.baz()"));
        // Leading digits in segments are rejected (covers e.g. "v1.2.3").
        assertFalse(OpenClassHandler.isValidClassName("v1.2.3"));
        // Whitespace, single-segment identifiers, and empty input are rejected.
        assertFalse(OpenClassHandler.isValidClassName("com.github foo.Bar"));
        assertFalse(OpenClassHandler.isValidClassName("BarService"));
        assertFalse(OpenClassHandler.isValidClassName(""));
    }

    @Test
    public void acceptsKotlinAndDollarInnerClassExpressions() {
        // Relaxed pattern: any dotted Java identifier with at least one '.',
        // including '$' inner-class separators and lowercase last segments.
        assertTrue(OpenClassHandler.isValidClassName("com.example.api"));
        assertTrue(OpenClassHandler.isValidClassName("org.junit.jupiter.api"));
        assertTrue(OpenClassHandler.isValidClassName("com.github.foo.Outer$Inner"));
    }

    @Test
    public void reportsInvalidClassNamesWithoutInvokingNavigator() throws Exception {
        CapturingJsCallback jsCallback = new CapturingJsCallback();
        AtomicBoolean invoked = new AtomicBoolean(false);
        OpenClassHandler handler = new OpenClassHandler(
            createContext(createProject(), jsCallback),
            (project, fqcn, onFailure) -> {
                invoked.set(true);
                return true;
            }
        );

        handler.handleOpenClass("com.github.foo.Bar#baz");

        assertFalse(invoked.get());
        assertEquals(
            "Cannot open class: invalid class name (com.github.foo.Bar#baz)",
            jsCallback.awaitLastMessage()
        );
    }

    @Test
    public void reportsUnavailableProjectBeforeAsyncNavigation() throws Exception {
        CapturingJsCallback jsCallback = new CapturingJsCallback();
        OpenClassHandler handler = new OpenClassHandler(
            createContext(null, jsCallback),
            (project, fqcn, onFailure) -> true
        );

        handler.handleOpenClass("com.github.foo.BarService");

        assertEquals("Cannot open class: project is not available", jsCallback.awaitLastMessage());
    }

    @Test
    public void surfacesNavigatorReportedNotFoundErrors() throws Exception {
        CapturingJsCallback jsCallback = new CapturingJsCallback();
        OpenClassHandler handler = new OpenClassHandler(
            createContext(createProject(), jsCallback),
            (project, fqcn, onFailure) -> {
                onFailure.accept("Cannot open class: not found (" + fqcn + ")");
                return true;
            }
        );

        handler.executeNavigation(createProject(), "com.github.foo.BarService");

        assertEquals(
            "Cannot open class: not found (com.github.foo.BarService)",
            jsCallback.awaitLastMessage()
        );
    }

    @Test
    public void reportsNavigatorExceptionsAsGenericOpenErrors() throws Exception {
        CapturingJsCallback jsCallback = new CapturingJsCallback();
        OpenClassHandler handler = new OpenClassHandler(
            createContext(createProject(), jsCallback),
            (project, fqcn, onFailure) -> {
                throw new IllegalStateException("boom");
            }
        );

        handler.executeNavigation(createProject(), "com.github.foo.BarService");

        assertEquals("Cannot open class: com.github.foo.BarService", jsCallback.awaitLastMessage());
    }

    private static HandlerContext createContext(Project project, CapturingJsCallback jsCallback) {
        return new HandlerContext(project, null, null, null, jsCallback);
    }

    private static Project createProject() {
        return (Project) Proxy.newProxyInstance(
            OpenClassHandlerTest.class.getClassLoader(),
            new Class<?>[]{Project.class},
            (proxy, method, args) -> {
                return switch (method.getName()) {
                    case "isDisposed" -> false;
                    case "getBasePath" -> null;
                    case "getName" -> "test-project";
                    case "toString" -> "test-project";
                    case "hashCode" -> 1;
                    case "equals" -> proxy == args[0];
                    default -> defaultValue(method.getReturnType());
                };
            }
        );
    }

    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }

        if (boolean.class.equals(returnType)) {
            return false;
        }
        if (int.class.equals(returnType)) {
            return 0;
        }
        if (long.class.equals(returnType)) {
            return 0L;
        }
        if (double.class.equals(returnType)) {
            return 0D;
        }
        if (float.class.equals(returnType)) {
            return 0F;
        }
        if (short.class.equals(returnType)) {
            return (short) 0;
        }
        if (byte.class.equals(returnType)) {
            return (byte) 0;
        }
        if (char.class.equals(returnType)) {
            return (char) 0;
        }
        return null;
    }

    private static final class CapturingJsCallback implements HandlerContext.JsCallback {
        private final List<String> messages = new ArrayList<>();
        private final CountDownLatch latch = new CountDownLatch(1);

        @Override
        public synchronized void callJavaScript(String functionName, String... args) {
            if (!"addErrorMessage".equals(functionName) || args.length == 0) {
                return;
            }

            messages.add(args[0]);
            latch.countDown();
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }

        synchronized String awaitLastMessage() throws Exception {
            assertTrue("Expected addErrorMessage callback", latch.await(2, TimeUnit.SECONDS));
            return messages.get(messages.size() - 1);
        }
    }
}
