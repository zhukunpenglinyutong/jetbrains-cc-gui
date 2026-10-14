package com.github.claudecodegui.startup;

import com.github.claudecodegui.clawbot.ClawBotGatewayRuntimeService;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.ProjectActivity;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;

/** Starts the application-scoped Claw Bot gateway without blocking project startup. */
public final class ClawBotGatewayStartupActivity implements ProjectActivity {

    private static final Logger LOG = Logger.getInstance(ClawBotGatewayStartupActivity.class);

    @Nullable
    @Override
    public Object execute(@NotNull Project project, @NotNull Continuation<? super Unit> continuation) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            if (project.isDisposed()) {
                return;
            }
            try {
                ClawBotGatewayRuntimeService.getInstance().start();
            } catch (IOException | RuntimeException error) {
                LOG.warn("[ClawBotGatewayStartup] Gateway startup deferred: " + error.getMessage());
            }
        });
        return Unit.INSTANCE;
    }
}
