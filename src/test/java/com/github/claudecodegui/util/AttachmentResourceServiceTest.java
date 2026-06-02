package com.github.claudecodegui.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class AttachmentResourceServiceTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void resolveAttachmentUrlRebuildsResourceAfterRegistryMiss() throws Exception {
        AttachmentStorageService storage = AttachmentStorageService.getInstance();
        Path storeDir = storage.getStoreDir();
        Files.createDirectories(storeDir);

        @SuppressWarnings("unchecked")
        Map<String, AttachmentResourceService.AttachmentResource> resources =
                (Map<String, AttachmentResourceService.AttachmentResource>) privateStaticField("ATTACHMENT_RESOURCES");
        resources.clear();

        File file = storeDir.resolve("fallback-rebuild-test.png").toFile();
        Files.writeString(file.toPath(), "image-fallback");

        AttachmentResourceService.AttachmentResource registered =
                AttachmentResourceService.registerAttachmentFile(file, "image/png");
        String url = registered.url();

        resources.clear();

        AttachmentResourceService.AttachmentResource rebuilt =
                AttachmentResourceService.resolveAttachmentUrl(url);

        assertNotNull("resource should be rebuilt from persisted attachment file", rebuilt);
        assertEquals(file.getCanonicalFile().toPath(), rebuilt.path());
        assertNotNull(AttachmentResourceService.resolveAttachmentUrl(url));

        Files.deleteIfExists(file.toPath());
    }

    @Test
    public void resolveAttachmentUrlRebuildsNonStoreDirResourceFromUrlPathHint() throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, AttachmentResourceService.AttachmentResource> resources =
                (Map<String, AttachmentResourceService.AttachmentResource>) privateStaticField("ATTACHMENT_RESOURCES");
        resources.clear();

        File file = folder.newFile("history-local-image.png");
        Files.writeString(file.toPath(), "history-image");

        AttachmentResourceService.AttachmentResource registered =
                AttachmentResourceService.registerAttachmentFile(file, "image/png");
        String url = registered.url();

        resources.clear();

        AttachmentResourceService.AttachmentResource rebuilt =
                AttachmentResourceService.resolveAttachmentUrl(url);

        assertNotNull("resource should be rebuilt for historical images outside storeDir", rebuilt);
        assertEquals(file.getCanonicalFile().toPath(), rebuilt.path());
    }

    @Test
    public void resolveAttachmentUrlAsDataUriReadsRegisteredResourceFile() throws Exception {
        File file = folder.newFile("data-uri-image.png");
        Files.writeString(file.toPath(), "image-bytes");

        AttachmentResourceService.AttachmentResource registered =
                AttachmentResourceService.registerAttachmentFile(file, "image/png");

        assertEquals(
                "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
                AttachmentResourceService.resolveAttachmentUrlAsDataUri(registered.url())
        );
    }

    @Test
    public void resolveAttachmentUrlAsDataUriRebuildsResourceAfterRegistryMiss() throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, AttachmentResourceService.AttachmentResource> resources =
                (Map<String, AttachmentResourceService.AttachmentResource>) privateStaticField("ATTACHMENT_RESOURCES");
        resources.clear();

        File file = folder.newFile("data-uri-rebuild.png");
        Files.writeString(file.toPath(), "image-rebuild");

        AttachmentResourceService.AttachmentResource registered =
                AttachmentResourceService.registerAttachmentFile(file, "image/png");
        String url = registered.url();
        resources.clear();

        assertEquals(
                "data:image/png;base64,aW1hZ2UtcmVidWlsZA==",
                AttachmentResourceService.resolveAttachmentUrlAsDataUri(url)
        );
    }

    @Test
    public void registeredAttachmentResourcesAreBoundedByLruCapacity() throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, AttachmentResourceService.AttachmentResource> resources =
                (Map<String, AttachmentResourceService.AttachmentResource>) privateStaticField("ATTACHMENT_RESOURCES");
        int maxResources = (int) privateStaticField("MAX_REGISTERED_RESOURCES");

        resources.clear();
        String firstUrl = null;
        String lastUrl = null;
        for (int i = 0; i < maxResources + 1; i++) {
            File file = folder.newFile("attachment-" + i + ".png");
            Files.writeString(file.toPath(), "image-" + i);
            String url = AttachmentResourceService.registerAttachmentFile(file, "image/png").url();
            if (i == 0) {
                firstUrl = url;
            }
            lastUrl = url;
        }

        assertTrue(resources.size() <= maxResources);
        assertNotNull(lastUrl);
        String oldestUrl = firstUrl;
        assertFalse("oldest resource should be evicted from the in-memory registry when capacity is exceeded",
                resources.values().stream().anyMatch(resource -> oldestUrl.equals(resource.url())));
        assertNotNull("newest resource should remain registered",
                AttachmentResourceService.resolveAttachmentUrl(lastUrl));
        assertTrue(resources.size() <= maxResources);
    }

    private static Object privateStaticField(String name) throws Exception {
        Field field = AttachmentResourceService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(null);
    }
}
