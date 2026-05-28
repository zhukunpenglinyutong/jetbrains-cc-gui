package com.github.claudecodegui.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class AttachmentResourceServiceTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

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
        assertFalse("oldest resource should be evicted when capacity is exceeded",
                AttachmentResourceService.resolveAttachmentUrl(firstUrl) != null);
        assertNotNull("newest resource should remain registered",
                AttachmentResourceService.resolveAttachmentUrl(lastUrl));
    }

    private static Object privateStaticField(String name) throws Exception {
        Field field = AttachmentResourceService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(null);
    }
}
