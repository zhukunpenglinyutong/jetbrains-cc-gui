package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit-tests {@link ClaudeDaemonCoordinator#shouldReloadSdk}: a daemon keeps the SDK it imported,
 * so it is replaced after the SDK changes, but never while it is serving a request.
 */
public class ClaudeDaemonCoordinatorTest {

    @Test
    public void keepsDaemonWhenSdkNeverChanged() {
        assertFalse(ClaudeDaemonCoordinator.shouldReloadSdk(0, 0, 3, 1, 0));
    }

    @Test
    public void reloadsIdleDaemonLaunchedBeforeSdkChange() {
        assertTrue(ClaudeDaemonCoordinator.shouldReloadSdk(1, 0, 1, 1, 0));
    }

    @Test
    public void keepsDaemonLaunchedAfterSdkChange() {
        assertFalse(ClaudeDaemonCoordinator.shouldReloadSdk(2, 2, 1, 1, 0));
    }

    @Test
    public void keepsBusyDaemonUntilItsRequestsFinish() {
        assertFalse(ClaudeDaemonCoordinator.shouldReloadSdk(1, 0, 1, 1, 1));
    }

    @Test
    public void reloadsProcessTheCoordinatorDidNotLaunchOnceSdkChanged() {
        assertTrue(ClaudeDaemonCoordinator.shouldReloadSdk(1, 1, 2, 1, 0));
    }
}
