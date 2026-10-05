package com.github.claudecodegui.provider.common;

import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/** Shared cooperative cancellation check for history readers. */
public final class HistoryCancellation {

    private HistoryCancellation() {
    }

    public static void check(BooleanSupplier cancellation) {
        if (cancellation != null && cancellation.getAsBoolean()) {
            throw new CancellationException("History loading was cancelled");
        }
    }
}
