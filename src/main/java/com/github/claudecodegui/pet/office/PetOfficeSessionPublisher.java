package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.pet.CodexPetFloatingService;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/** Application-owned local participant, independent of JCEF page/selection and the ClawBot gateway. */
@Service(Service.Level.APP)
public final class PetOfficeSessionPublisher implements Disposable {
    private static final Logger LOG = Logger.getInstance(PetOfficeSessionPublisher.class);
    private final PetOfficeSessionRegistry registry = new PetOfficeSessionRegistry(UUID.randomUUID().toString());
    private final Map<Project, String> projectIds = new WeakHashMap<>();
    private final PetOfficeTabNavigator navigator = new PetOfficeTabNavigator(registry,
            action -> ApplicationManager.getApplication().invokeLater(action, com.intellij.openapi.application.ModalityState.any()));
    private ScheduledFuture<?> observationTask;
    private boolean disposed;

    /** A hidden/reloaded Office still owns its observer; only explicit browser disposal releases it. */
    public synchronized void setOfficeActive(boolean active) {
        if (disposed) {
            return;
        }
        if (active && observationTask == null) {
            registry.observe();
            observationTask = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
                try {
                    registry.observe();
                } catch (RuntimeException error) {
                    LOG.warn("[PetOffice] Local observation failed", error);
                }
            }, 5, 5, TimeUnit.SECONDS);
        } else if (!active && observationTask != null) {
            observationTask.cancel(false);
            observationTask = null;
        }
    }

    public static PetOfficeSessionPublisher getInstance() {
        return ApplicationManager.getApplication().getService(PetOfficeSessionPublisher.class);
    }

    public synchronized PetOfficeSessionRegistry.Registration register(String contentHandleId, Project project,
                                                                       String tabLabel, SessionState state) {
        if (disposed || project.isDisposed()) {
            return null;
        }
        if (projectIds.size() >= PetOfficeSessionRegistry.MAX_SOURCES && !projectIds.containsKey(project)) {
            return null;
        }
        String projectId = projectIds.computeIfAbsent(project, ignored -> UUID.randomUUID().toString());
        ApplicationInfo info = ApplicationInfo.getInstance();
        PetOfficeRuntimeService.getInstance().start();
        return registry.register(new PetOfficeSessionRegistry.Metadata(contentHandleId, info.getBuild().getProductCode(),
                info.getVersionName(), projectId, project.getName(), tabLabel), state);
    }

    public PetOfficeSessionRegistry.CompleteSnapshot snapshot() {
        return registry.snapshot();
    }

    /** Sample real backend ownership on the bounded runtime worker; a heartbeat never calls this implicitly. */
    public PetOfficeSessionRegistry.CompleteSnapshot sample() {
        registry.observe();
        return registry.snapshot();
    }

    public PetOfficeTabNavigator navigator() {
        return navigator;
    }

    public CodexPetFloatingService.VisualConfiguration visualConfiguration(String projectId) {
        Project owner = null;
        synchronized (this) {
            for (Map.Entry<Project, String> entry : projectIds.entrySet()) {
                if (entry.getValue().equals(projectId)) {
                    owner = entry.getKey();
                    break;
                }
            }
        }
        return owner == null || owner.isDisposed() ? null : CodexPetFloatingService.getInstance(owner).visualConfiguration();
    }

    @Override
    public synchronized void dispose() {
        if (!disposed) {
            disposed = true;
            if (observationTask != null) {
                observationTask.cancel(false);
                observationTask = null;
            }
            registry.close();
            navigator.clear();
            projectIds.clear();
        }
    }
}
