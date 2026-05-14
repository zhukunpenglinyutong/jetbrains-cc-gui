package com.github.claudecodegui.provider.common;

import org.junit.Test;

import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.OutputStreamWriter;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class DaemonBridgeTest {

    // HEARTBEAT_TIMEOUT_MS = 45_000; just over threshold triggers unresponsive
    private static final long JUST_OVER_HEARTBEAT_THRESHOLD = 46_000;
    // ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000; well over for active-request timeout
    private static final long OVER_ACTIVE_REQUEST_THRESHOLD = 190_000;
    // Recent activity within threshold
    private static final long RECENT_ACTIVITY = 5_000;

    @Test
    public void staleHeartbeatWithoutActiveRequestsIsUnresponsive() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, JUST_OVER_HEARTBEAT_THRESHOLD, 0));
    }

    @Test
    public void activeRequestWithRecentOutputGetsGraceWindow() {
        assertFalse(DaemonBridge.shouldTreatAsUnresponsive(JUST_OVER_HEARTBEAT_THRESHOLD, RECENT_ACTIVITY, 1));
    }

    @Test
    public void activeRequestWithNoRecentOutputEventuallyTimesOut() {
        assertTrue(DaemonBridge.shouldTreatAsUnresponsive(OVER_ACTIVE_REQUEST_THRESHOLD, OVER_ACTIVE_REQUEST_THRESHOLD, 1));
    }

    @Test
    public void daemonBridgeUsesPlatformTerminationHelperForShutdownPaths() throws Exception {
        String source = Files.readString(Paths.get(
                "src", "main", "java", "com", "github", "claudecodegui", "provider", "common", "DaemonBridge.java"
        ));

        assertTrue(source.contains("PlatformUtils.terminateProcessAndWait(daemonProcess, 3, TimeUnit.SECONDS)"));
        assertTrue(source.contains("PlatformUtils.terminateProcessAndWait(oldProcess, 2, TimeUnit.SECONDS)"));
        assertFalse(source.contains("daemonProcess.destroyForcibly()"));
        assertFalse(source.contains("oldProcess.destroyForcibly()"));
    }

    @Test
    public void sendAbortOnlyCompletesActiveRequestAndKeepsQueuedRequestsRegistered() throws Exception {
        DaemonBridge bridge = new DaemonBridge(null, null, null);

        AtomicBoolean activeAborted = new AtomicBoolean(false);
        AtomicBoolean queuedAborted = new AtomicBoolean(false);
        CompletableFuture<Boolean> activeFuture = new CompletableFuture<>();
        CompletableFuture<Boolean> queuedFuture = new CompletableFuture<>();

        setAtomicBooleanField(bridge, "isRunning", true);
        setField(bridge, "daemonStdin", new BufferedWriter(
                new OutputStreamWriter(new ByteArrayOutputStream(), StandardCharsets.UTF_8)
        ));

        @SuppressWarnings("unchecked")
        ConcurrentHashMap<String, Object> pendingRequests =
                (ConcurrentHashMap<String, Object>) getField(bridge, "pendingRequests");
        pendingRequests.put("1", createRequestHandler("1", callback(activeAborted), activeFuture));
        pendingRequests.put("2", createRequestHandler("2", callback(queuedAborted), queuedFuture));

        invokeHandleDaemonOutput(bridge, "{\"type\":\"daemon\",\"event\":\"queue_started\",\"requestId\":\"1\"}");
        bridge.sendAbort();

        assertTrue(activeAborted.get());
        assertTrue(activeFuture.isDone());
        assertEquals(Boolean.FALSE, activeFuture.getNow(Boolean.TRUE));

        assertFalse(queuedAborted.get());
        assertFalse(queuedFuture.isDone());
        assertTrue(pendingRequests.containsKey("2"));
        assertFalse(pendingRequests.containsKey("1"));

        @SuppressWarnings("unchecked")
        AtomicReference<String> activeRequestId =
                (AtomicReference<String>) getField(bridge, "activeRequestId");
        assertNull(activeRequestId.get());
    }

    private static DaemonBridge.DaemonOutputCallback callback(AtomicBoolean aborted) {
        return new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
            }

            @Override
            public void onStderr(String text) {
            }

            @Override
            public void onError(String error) {
            }

            @Override
            public void onComplete(boolean success) {
            }

            @Override
            public void onAbort() {
                aborted.set(true);
            }
        };
    }

    private static Object createRequestHandler(
            String requestId,
            DaemonBridge.DaemonOutputCallback callback,
            CompletableFuture<Boolean> future
    ) throws Exception {
        Class<?> handlerClass = findRequestHandlerClass();
        Constructor<?> constructor =
                handlerClass.getDeclaredConstructor(String.class, DaemonBridge.DaemonOutputCallback.class, CompletableFuture.class);
        constructor.setAccessible(true);
        return constructor.newInstance(requestId, callback, future);
    }

    private static Class<?> findRequestHandlerClass() {
        for (Class<?> nested : DaemonBridge.class.getDeclaredClasses()) {
            if ("RequestHandler".equals(nested.getSimpleName())) {
                return nested;
            }
        }
        throw new IllegalStateException("RequestHandler class not found");
    }

    private static void invokeHandleDaemonOutput(DaemonBridge bridge, String jsonLine) throws Exception {
        Method method = DaemonBridge.class.getDeclaredMethod("handleDaemonOutput", String.class);
        method.setAccessible(true);
        method.invoke(bridge, jsonLine);
    }

    private static Object getField(Object target, String fieldName) throws Exception {
        Field field = target.getClass().getDeclaredField(fieldName);
        field.setAccessible(true);
        return field.get(target);
    }

    private static void setField(Object target, String fieldName, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(fieldName);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static void setAtomicBooleanField(Object target, String fieldName, boolean value) throws Exception {
        Field field = target.getClass().getDeclaredField(fieldName);
        field.setAccessible(true);
        AtomicBoolean atomicBoolean = (AtomicBoolean) field.get(target);
        atomicBoolean.set(value);
    }
}
