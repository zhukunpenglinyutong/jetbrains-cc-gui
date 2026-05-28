package com.github.claudecodegui.service;

import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Service(Service.Level.APP)
public final class PluginLifecycleService implements Disposable {

    private static final Logger LOG = Logger.getInstance(PluginLifecycleService.class);
    private final Set<BaseSDKBridge> registeredBridges = Collections.newSetFromMap(new ConcurrentHashMap<>());

    public void registerBridge(BaseSDKBridge bridge) {
        registeredBridges.add(bridge);
        LOG.info("Registered bridge: " + bridge.getClass().getSimpleName());
    }

    public void unregisterBridge(BaseSDKBridge bridge) {
        registeredBridges.remove(bridge);
        LOG.info("Unregistered bridge: " + bridge.getClass().getSimpleName());
    }

    @Override
    public void dispose() {
        LOG.info("Plugin unloading, cleaning up all registered SDK bridges...");
        for (BaseSDKBridge bridge : registeredBridges) {
            try {
                bridge.cleanupAllProcesses();
            } catch (Exception e) {
                LOG.warn("Error cleaning up processes for bridge: " + bridge.getClass().getSimpleName(), e);
            }
        }
        registeredBridges.clear();
        LOG.info("All SDK bridges cleaned up.");
    }
}
