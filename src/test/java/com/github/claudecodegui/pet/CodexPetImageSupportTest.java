package com.github.claudecodegui.pet;

import org.junit.Test;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;
import java.util.Iterator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class CodexPetImageSupportTest {

    @Test
    public void decodesWebpWithoutRegisteringThePluginProviderInTheIdeRegistry() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            bundledImageIoProviderDecodesWebp();
            fixture.assertRegistryUnchanged();
        }
    }

    @Test
    public void prefersTheIdeWebpReaderOverTheBundledDecoder() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            // The bundled decoder could read this sheet too, so a read here proves the IDE reader goes first.
            StandInWebpReaderSpi ideReader = StandInWebpReaderSpi.decoding(1536, 1872);
            fixture.register(ideReader);

            BufferedImage image = CodexPetImageSupport.readImage(fixture.sheet());

            assertEquals(1536, image.getWidth());
            assertEquals(1872, image.getHeight());
            assertEquals(1, ideReader.reads());
        }
    }

    @Test
    public void loadsSheetsTheBundledDecoderRejectsThroughTheIdeReader() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            // TwelveMonkeys throws on this sheet, like it does on some valid lossless Petdex sheets.
            byte[] sheet = Arrays.copyOf(fixture.sheet(), 60);
            fixture.register(StandInWebpReaderSpi.decoding(1536, 1872));

            BufferedImage image = CodexPetImageSupport.readImage(sheet);

            assertEquals(1536, image.getWidth());
            assertEquals(1872, image.getHeight());
        }
    }

    @Test
    public void fallsBackToTheBundledDecoderWhenTheIdeWebpReaderFails() throws Exception {
        assertFallsBackToTheBundledDecoder(StandInWebpReaderSpi.failing(1536, 1872));
    }

    @Test
    public void fallsBackToTheBundledDecoderWhenTheIdeWebpReaderCrashes() throws Exception {
        assertFallsBackToTheBundledDecoder(StandInWebpReaderSpi.crashing(1536, 1872));
    }

    @Test
    public void returnsNullWhenEveryDecoderRejectsTheImage() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            assertNull(CodexPetImageSupport.readImage(Arrays.copyOf(fixture.sheet(), 60)));
        }
    }

    @Test
    public void rejectsOversizedImagesWithoutTryingAnotherDecoder() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            byte[] sheet = fixture.sheet();

            StandInWebpReaderSpi ideReader = StandInWebpReaderSpi.decoding(8192, 8192);
            fixture.register(ideReader);

            IOException error = assertThrows(IOException.class, () -> CodexPetImageSupport.readImage(sheet));

            assertEquals("INVALID_PET_IMAGE_DIMENSIONS", error.getMessage());
            assertEquals(0, ideReader.reads());
        }
    }

    @Test
    public void decodesPngThroughTheRegisteredReader() throws Exception {
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(3, 2, BufferedImage.TYPE_INT_ARGB), "png", png);

        BufferedImage image = CodexPetImageSupport.readImage(png.toByteArray());

        assertEquals(3, image.getWidth());
        assertEquals(2, image.getHeight());
    }

    @Test
    public void readsDecodedDimensionsWithoutGlobalWebpProvider() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            Path sheet = Files.createTempFile("pet-sheet", ".webp");
            try {
                Files.write(sheet, fixture.sheet());
                CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDecodedDimensions(sheet);

                assertEquals(1536, dimensions.getWidth());
                assertEquals(1872, dimensions.getHeight());
            } finally {
                Files.deleteIfExists(sheet);
            }
        }
    }

    @Test
    public void readsCanonicalPetdexPngDimensions() {
        byte[] bytes = pngHeader(1536, 1872);

        String mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.png"), bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);

        assertEquals("image/png", mimeType);
        assertNotNull(dimensions);
        assertEquals(1536, dimensions.getWidth());
        assertEquals(1872, dimensions.getHeight());
        assertTrue(CodexPetImageSupport.isCanonicalPetdexSheet(dimensions));
    }

    @Test
    public void readsVp8xWebpDimensionsWithoutDecodingImage() {
        byte[] bytes = vp8xHeader(1536, 2288);

        String mimeType = CodexPetImageSupport.detectMimeType(Path.of("sprite.webp"), bytes);
        CodexPetImageSupport.ImageDimensions dimensions = CodexPetImageSupport.readDimensions(mimeType, bytes);

        assertEquals("image/webp", mimeType);
        assertNotNull(dimensions);
        assertEquals(1536, dimensions.getWidth());
        assertEquals(2288, dimensions.getHeight());
        assertTrue(CodexPetImageSupport.isCanonicalPetdexSheet(dimensions));
    }

    @Test
    public void rejectsOversizedAndWrongGridImages() {
        CodexPetImageSupport.ImageDimensions oversized =
                new CodexPetImageSupport.ImageDimensions(5000, 5000);
        CodexPetImageSupport.ImageDimensions excessivePixels =
                new CodexPetImageSupport.ImageDimensions(4096, 4096);
        CodexPetImageSupport.ImageDimensions wrongGrid =
                new CodexPetImageSupport.ImageDimensions(1600, 1872);

        assertFalse(CodexPetImageSupport.hasSafeDimensions(oversized));
        assertFalse(CodexPetImageSupport.hasSafeDimensions(excessivePixels));
        assertFalse(CodexPetImageSupport.isCanonicalPetdexSheet(wrongGrid));
    }

    @Test
    public void rejectsGifBeyondFrameBudget() throws Exception {
        byte[] safeGif = animatedGif(2);
        byte[] excessiveGif = animatedGif(CodexPetImageSupport.MAX_ANIMATED_FRAMES + 1);

        assertTrue(CodexPetImageSupport.hasSafeFrameBudget("image/gif", safeGif));
        assertFalse(CodexPetImageSupport.hasSafeFrameBudget("image/gif", excessiveGif));
    }

    @Test
    public void bundledImageIoProviderDecodesWebp() throws Exception {
        byte[] lossyWebp256 = Base64.getDecoder().decode(
                "UklGRrYAAABXRUJQVlA4IKoAAACwEACdASoAAQABPm02mUmCAoAIANiWlu4XaxHtwAABPYB77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJwoAP7/Qwv//hyp9O3sf//Ys5bAsQAAAAAAAAAAAA==");

        BufferedImage image = CodexPetImageSupport.readImage(lossyWebp256);

        assertNotNull(image);
        assertEquals(256, image.getWidth());
        assertEquals(256, image.getHeight());
    }

    private static void assertFallsBackToTheBundledDecoder(StandInWebpReaderSpi ideReader) throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            fixture.register(ideReader);

            BufferedImage image = CodexPetImageSupport.readImage(fixture.sheet());

            assertEquals(1536, image.getWidth());
            assertEquals(1872, image.getHeight());
            assertEquals(1, ideReader.reads());
            assertEquals(1, ideReader.disposals());
        }
    }

    private static byte[] pngHeader(int width, int height) {
        byte[] bytes = new byte[24];
        bytes[0] = (byte) 0x89;
        bytes[1] = 0x50;
        bytes[2] = 0x4e;
        bytes[3] = 0x47;
        bytes[4] = 0x0d;
        bytes[5] = 0x0a;
        bytes[6] = 0x1a;
        bytes[7] = 0x0a;
        writeBigEndianInt(bytes, 16, width);
        writeBigEndianInt(bytes, 20, height);
        return bytes;
    }

    private static byte[] vp8xHeader(int width, int height) {
        byte[] bytes = new byte[30];
        writeAscii(bytes, 0, "RIFF");
        writeAscii(bytes, 8, "WEBP");
        writeAscii(bytes, 12, "VP8X");
        writeLittleEndian24(bytes, 24, width - 1);
        writeLittleEndian24(bytes, 27, height - 1);
        return bytes;
    }

    private static byte[] animatedGif(int frameCount) throws Exception {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("gif");
        ImageWriter writer = writers.next();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ImageOutputStream output = ImageIO.createImageOutputStream(bytes)) {
            writer.setOutput(output);
            writer.prepareWriteSequence(null);
            BufferedImage frame = new BufferedImage(1, 1, BufferedImage.TYPE_INT_ARGB);
            for (int index = 0; index < frameCount; index++) {
                writer.writeToSequence(new IIOImage(frame, null, null), writer.getDefaultWriteParam());
            }
            writer.endWriteSequence();
        } finally {
            writer.dispose();
        }
        return bytes.toByteArray();
    }

    private static void writeAscii(byte[] bytes, int offset, String value) {
        for (int i = 0; i < value.length(); i++) {
            bytes[offset + i] = (byte) value.charAt(i);
        }
    }

    private static void writeBigEndianInt(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) (value >>> 24);
        bytes[offset + 1] = (byte) (value >>> 16);
        bytes[offset + 2] = (byte) (value >>> 8);
        bytes[offset + 3] = (byte) value;
    }

    private static void writeLittleEndian24(byte[] bytes, int offset, int value) {
        bytes[offset] = (byte) value;
        bytes[offset + 1] = (byte) (value >>> 8);
        bytes[offset + 2] = (byte) (value >>> 16);
    }
}
