package com.github.claudecodegui.pet;

import javax.imageio.ImageIO;
import javax.imageio.spi.IIORegistry;
import javax.imageio.spi.ImageReaderSpi;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertFalse;

/** Simulates an IDE registry that cannot see the plugin's service providers. */
public final class WebpTestFixture implements AutoCloseable {
    private final IIORegistry registry = IIORegistry.getDefaultInstance();
    private final List<ImageReaderSpi> removed = new ArrayList<>();

    public WebpTestFixture() {
        registry.getServiceProviders(ImageReaderSpi.class, true).forEachRemaining(provider -> {
            if (Arrays.stream(provider.getFormatNames()).anyMatch("webp"::equalsIgnoreCase)) {
                removed.add(provider);
            }
        });
        removed.forEach(registry::deregisterServiceProvider);
        assertRegistryUnchanged();
    }

    public byte[] sheet() throws IOException {
        try (var input = WebpTestFixture.class.getResourceAsStream("/pet/canonical-sheet.webp")) {
            if (input == null) {
                throw new IOException("Missing generated WebP test fixture");
            }
            return input.readAllBytes();
        }
    }

    public void assertRegistryUnchanged() {
        assertFalse(ImageIO.getImageReadersByMIMEType("image/webp").hasNext());
    }

    @Override
    public void close() {
        removed.forEach(registry::registerServiceProvider);
    }
}
