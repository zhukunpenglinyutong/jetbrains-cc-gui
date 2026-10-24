package com.github.claudecodegui.pet.office;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicReference;

/** Allows only the entry and its platform-generated, browser-local HTML wrapper. */
public final class PetOfficeNavigationPolicy {
    private static final String WRAPPER_PREFIX = "file:///jbcefbrowser/";
    private final String entryUrl;
    private final AtomicReference<String> wrapperUrl = new AtomicReference<>();

    public PetOfficeNavigationPolicy(String entryUrl) {
        this.entryUrl = Objects.requireNonNull(entryUrl);
    }

    public boolean allows(String url, boolean mainFrame) {
        if (!mainFrame || url == null || url.length() > 4096) {
            return false;
        }
        if (entryUrl.equals(url)) {
            return true;
        }
        String pinned = wrapperUrl.get();
        if (pinned != null) {
            return pinned.equals(url);
        }
        String suffix = "#url=" + entryUrl;
        if (!url.startsWith(WRAPPER_PREFIX) || !url.endsWith(suffix)) {
            return false;
        }
        String browserId = url.substring(WRAPPER_PREFIX.length(), url.length() - suffix.length());
        try {
            // The SDK uses the browser's canonical signed integer ID in this path.
            if (!Integer.toString(Integer.parseInt(browserId)).equals(browserId)) {
                return false;
            }
        } catch (NumberFormatException invalid) {
            return false;
        }
        return wrapperUrl.compareAndSet(null, url) || url.equals(wrapperUrl.get());
    }
}
