package com.github.claudecodegui.pet;

import javax.imageio.IIOException;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageTypeSpecifier;
import javax.imageio.metadata.IIOMetadata;
import javax.imageio.spi.ImageReaderSpi;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

/** Stands in for a WebP reader the IDE registers itself, such as the libwebp reader of WebP Support. */
public final class StandInWebpReaderSpi extends ImageReaderSpi {
    private enum Mode { DECODE, FAIL, CRASH }

    private final int width;
    private final int height;
    private final Mode mode;
    private final AtomicInteger reads = new AtomicInteger();
    private final AtomicInteger disposals = new AtomicInteger();

    private StandInWebpReaderSpi(int width, int height, Mode mode) {
        super("test", "1", new String[]{"webp"}, new String[]{"webp"}, new String[]{"image/webp"},
                StandInReader.class.getName(), new Class<?>[]{ImageInputStream.class}, null,
                false, null, null, null, null, false, null, null, null, null);
        this.width = width;
        this.height = height;
        this.mode = mode;
    }

    /** A reader that decodes any RIFF/WEBP input to a blank image of the given size. */
    public static StandInWebpReaderSpi decoding(int width, int height) {
        return new StandInWebpReaderSpi(width, height, Mode.DECODE);
    }

    /** A reader that reports the given size but fails to decode the pixels. */
    public static StandInWebpReaderSpi failing(int width, int height) {
        return new StandInWebpReaderSpi(width, height, Mode.FAIL);
    }

    /** A reader that crashes with a runtime exception, the way TwelveMonkeys does on some lossless sheets. */
    public static StandInWebpReaderSpi crashing(int width, int height) {
        return new StandInWebpReaderSpi(width, height, Mode.CRASH);
    }

    public int reads() {
        return reads.get();
    }

    public int disposals() {
        return disposals.get();
    }

    @Override
    public boolean canDecodeInput(Object source) throws IOException {
        if (!(source instanceof ImageInputStream)) {
            return false;
        }
        ImageInputStream input = (ImageInputStream) source;
        byte[] header = new byte[12];
        input.mark();
        try {
            input.readFully(header);
        } catch (EOFException e) {
            return false;
        } finally {
            input.reset();
        }
        String text = new String(header, StandardCharsets.US_ASCII);
        return text.startsWith("RIFF") && text.endsWith("WEBP");
    }

    @Override
    public ImageReader createReaderInstance(Object extension) {
        return new StandInReader(this);
    }

    @Override
    public String getDescription(Locale locale) {
        return "Stand-in IDE WebP reader";
    }

    private final class StandInReader extends ImageReader {
        private StandInReader(ImageReaderSpi provider) {
            super(provider);
        }

        @Override
        public int getNumImages(boolean allowSearch) {
            return 1;
        }

        @Override
        public int getWidth(int imageIndex) {
            return width;
        }

        @Override
        public int getHeight(int imageIndex) {
            return height;
        }

        @Override
        public Iterator<ImageTypeSpecifier> getImageTypes(int imageIndex) {
            return Collections.emptyIterator();
        }

        @Override
        public IIOMetadata getStreamMetadata() {
            return null;
        }

        @Override
        public IIOMetadata getImageMetadata(int imageIndex) {
            return null;
        }

        @Override
        public BufferedImage read(int imageIndex, ImageReadParam param) throws IOException {
            reads.incrementAndGet();
            if (mode == Mode.FAIL) {
                throw new IIOException("Stand-in decoder failure");
            }
            if (mode == Mode.CRASH) {
                throw new ArrayIndexOutOfBoundsException("Stand-in decoder crash");
            }
            return new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        }

        @Override
        public void dispose() {
            disposals.incrementAndGet();
            super.dispose();
        }
    }
}
