package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class UiFontResourceServiceTest {

    @Test
    public void shouldResolveOnlyRegisteredFontResourceUrls() throws Exception {
        Path fontFile = Files.createTempFile("registered-ui-font", ".otf");
        Files.write(fontFile, new byte[] {1, 2, 3});
        fontFile.toFile().deleteOnExit();

        UiFontResourceService.FontResource resource =
            UiFontResourceService.registerFontFile(fontFile.toFile());

        UiFontResourceService.FontResource resolved =
            UiFontResourceService.resolveFontUrl(resource.url());

        assertEquals(fontFile.toFile().getCanonicalFile().toPath(), resolved.path());
        assertEquals("font/opentype", resolved.mimeType());
        assertEquals("opentype", resolved.fontFormat());
        assertNull(UiFontResourceService.resolveFontUrl(null));
        assertNull(UiFontResourceService.resolveFontUrl("https://example.com/font.otf"));
    }
}
