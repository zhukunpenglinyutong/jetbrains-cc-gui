package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.Supplier;

/** Retains a remote request across native async questions and their tracked follow-up turns. */
public final class ClawBotTurnLifecycle {
    private CompletableFuture<Void> tail;
    private int responses;
    private boolean launchingContinuation;
    private boolean closed;

    public synchronized void bind(CompletableFuture<Void> completion) {
        this.tail = completion;
    }

    /** No native control I/O runs under this monitor or the session message lock. */
    public JsonObject respond(Supplier<JsonObject> response, Supplier<String> threadId, BooleanSupplier current,
                              Function<String, CompletableFuture<Void>> continuation, Executor executor) {
        synchronized (this) {
            if (closed || !current.getAsBoolean()) {
                return staleResponse();
            }
            responses++;
        }
        try {
            JsonObject result = response.get();
            if (result == null || result.has("error") || !result.has("replied") || !result.get("replied").getAsBoolean()
                    || !result.has("followUp") || !result.get("followUp").isJsonObject()) {
                return result;
            }
            JsonObject followUp = result.getAsJsonObject("followUp");
            if (!followUp.has("threadId") || !followUp.has("text") || !followUp.get("text").isJsonPrimitive()
                    || !followUp.get("threadId").getAsString().equals(threadId.get())) {
                return staleResponse();
            }
            String input = followUp.get("text").getAsString();
            if (input.isBlank()) {
                return staleResponse();
            }
            CompletableFuture<Void> previous;
            CompletableFuture<Void> next = new CompletableFuture<>();
            synchronized (this) {
                previous = tail;
                tail = next;
            }
            if (previous == null) {
                next.completeExceptionally(new IllegalStateException("Remote turn has not started"));
            } else {
                previous.thenComposeAsync(ignored -> {
                    synchronized (this) {
                        if (closed || !current.getAsBoolean()) {
                            return CompletableFuture.<Void>failedFuture(new IllegalStateException("Remote turn changed"));
                        }
                        launchingContinuation = true;
                    }
                    try {
                        return continuation.apply(input);
                    } finally {
                        synchronized (this) {
                            launchingContinuation = false;
                        }
                    }
                }, executor).whenComplete((ignored, error) -> {
                    if (error == null) {
                        next.complete(null);
                    } else {
                        next.completeExceptionally(error);
                    }
                });
            }
            JsonObject consumed = result.deepCopy();
            // The backend owns this continuation; the browser must not enqueue it a second time.
            consumed.remove("followUp");
            return consumed;
        } finally {
            synchronized (this) {
                responses--;
            }
        }
    }

    public synchronized boolean finishIfReady(boolean pendingInteraction) {
        if (closed || tail == null || !tail.isDone() || responses != 0 || pendingInteraction) {
            return false;
        }
        closed = true;
        return true;
    }

    public synchronized boolean failed() {
        return tail != null && tail.isCompletedExceptionally();
    }

    public synchronized boolean finishIfObsolete(BooleanSupplier current) {
        if (closed || tail == null || responses != 0 || launchingContinuation || current.getAsBoolean()) {
            return false;
        }
        closed = true;
        return true;
    }

    public synchronized void close() {
        closed = true;
    }

    private static JsonObject staleResponse() {
        JsonObject error = new JsonObject();
        error.addProperty("error", "Unknown or stale remote Codex question");
        return error;
    }
}
