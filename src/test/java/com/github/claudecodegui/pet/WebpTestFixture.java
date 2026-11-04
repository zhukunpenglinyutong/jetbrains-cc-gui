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
    private final List<ImageReaderSpi> added = new ArrayList<>();

    public WebpTestFixture() {
        registry.getServiceProviders(ImageReaderSpi.class, true).forEachRemaining(provider -> {
            if (Arrays.stream(provider.getFormatNames()).anyMatch("webp"::equalsIgnoreCase)) {
                removed.add(provider);
            }
        });
        removed.forEach(registry::deregisterServiceProvider);
        try {
            assertRegistryUnchanged();
        } catch (AssertionError e) {
            close();
            throw e;
        }
    }

    public byte[] sheet() throws IOException {
        try (var input = WebpTestFixture.class.getResourceAsStream("/pet/canonical-sheet.webp")) {
            if (input == null) {
                throw new IOException("Missing generated WebP test fixture");
            }
            return input.readAllBytes();
        }
    }

    /** Registers a reader the IDE would own until the fixture closes. */
    public void register(ImageReaderSpi provider) {
        registry.registerServiceProvider(provider);
        added.add(provider);
    }

    public void assertRegistryUnchanged() {
        assertFalse(ImageIO.getImageReadersByMIMEType("image/webp").hasNext());
    }

    @Override
    public void close() {
        added.forEach(registry::deregisterServiceProvider);
        removed.forEach(registry::registerServiceProvider);
    }
}
