package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.ui.toolwindow.MessageDispatchGate;
import org.junit.Test;

import javax.imageio.ImageIO;
import java.awt.Image;
import java.awt.image.BaseMultiResolutionImage;
import java.awt.image.BufferedImage;
import java.awt.image.ImageObserver;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Guards the image-paste threading split without booting an IDE or reading the native clipboard.
 */
public class ClipboardHandlerTest {

    /** Keeps request ownership in the reply even when encoding is deferred. */
    @Test
    public void carriesRequestIdThroughEncoding() throws Exception {
        Fixture fixture = new Fixture();
        fixture.handler(ClipboardHandlerTest::image).handle("paste_image", "draft-request-1");
        fixture.edtTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertPastedImage(fixture.callback.scripts, image());
        assertTrue(fixture.callback.scripts.get(0).contains("requestId: \"draft-request-1\""));
    }

    /** A busy handler must settle excess requests before retaining more images or scheduling more reads. */
    @Test
    public void boundsPendingImageWorkAndRecoversAfterCompletion() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        for (int index = 0; index < 20; index++) {
            handler.handle("paste_image", "burst-" + index);
        }
        assertEquals(2, fixture.edtTasks.size());
        assertEquals(18, fixture.callback.scripts.size());
        fixture.edtTasks.remove().run();
        fixture.edtTasks.remove().run();
        assertEquals(2, fixture.backgroundTasks.size());
        fixture.backgroundTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        handler.handle("paste_image", "after-completion");
        assertEquals(1, fixture.edtTasks.size());
    }

    /** Claiming a native gesture must encode its original image even after the clipboard changes. */
    @Test
    public void capturesDistinctImagesBeforeTheFrontendRoundTrip() throws Exception {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(() -> {
            fail("snapshot claims must not read the current clipboard");
            return null;
        });
        BufferedImage first = image();
        BufferedImage second = image();
        second.setRGB(0, 0, 0xffabcdef);
        assertTrue(handler.offerImagePaste(first));
        String firstId = snapshotId(fixture.callback.scripts.get(0));
        assertTrue(handler.offerImagePaste(second));
        String secondId = snapshotId(fixture.callback.scripts.get(1));
        fixture.callback.scripts.clear();
        handler.handle("paste_image", "{\"requestId\":\"first\",\"snapshotId\":\"" + firstId + "\",\"scopeId\":\"draft-a\"}");
        handler.handle("paste_image", "{\"requestId\":\"second\",\"snapshotId\":\"" + secondId + "\",\"scopeId\":\"draft-a\"}");
        assertTrue(fixture.edtTasks.isEmpty());
        assertTrue(fixture.expirationTasks.isEmpty());
        fixture.backgroundTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertPastedImage(fixture.callback.scripts.subList(0, 1), first);
        assertPastedImage(fixture.callback.scripts.subList(1, 2), second);
    }

    /** Dropped offer events must release both retained snapshots and admission slots. */
    @Test
    public void expiresUnclaimedSnapshotsAndDoesNotRereadThem() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(() -> {
            fail("an expired snapshot must not fall back to the clipboard");
            return null;
        });
        assertTrue(handler.offerImagePaste(image()));
        String expired = snapshotId(fixture.callback.scripts.get(0));
        assertTrue(handler.offerImagePaste(image()));
        assertTrue(!handler.offerImagePaste(image()));
        fixture.expirationTasks.remove().run();
        fixture.expirationTasks.remove().run();
        fixture.callback.scripts.clear();
        handler.handle("paste_image", "{\"requestId\":\"expired\",\"snapshotId\":\"" + expired + "\",\"scopeId\":\"draft-a\"}");
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
        assertTrue(fixture.edtTasks.isEmpty());
        assertTrue(handler.offerImagePaste(image()));
        handler.dispose();
        assertTrue(fixture.expirationTasks.isEmpty());
        assertTrue(!handler.offerImagePaste(image()));
    }

    /** The macOS hook needs one EDT read before offering its snapshot, without an intervening JS round trip. */
    @Test
    public void capturesHookClipboardBeforeRequestingFrontendOwnership() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        handler.captureClipboardPaste();
        assertTrue(fixture.callback.scripts.isEmpty());
        fixture.edtTasks.remove().run();
        assertTrue(fixture.callback.scripts.get(0).contains("java-request-paste-image"));
        assertTrue(fixture.backgroundTasks.isEmpty());
        handler.dispose();
    }

    /** A retained native image must identify the draft that was active at its gesture. */
    @Test
    public void offersCarryThePublishedDraftScope() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        handler.handle("paste_image_scope", "draft-a");
        assertTrue(handler.offerImagePaste(image()));
        assertTrue(fixture.callback.scripts.get(0).contains("scopeId: \"draft-a\""));
    }

    /** Retiring a draft must release unclaimed snapshots immediately, before their offer events arrive. */
    @Test
    public void retiringDraftReleasesSnapshotsAndRejectsTheirClaims() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        handler.handle("paste_image_scope", "draft-a");
        assertTrue(handler.offerImagePaste(image()));
        String first = snapshotId(fixture.callback.scripts.get(0));
        assertTrue(handler.offerImagePaste(image()));
        fixture.callback.scripts.clear();
        handler.handle("paste_image_scope", "draft-b");
        assertTrue(fixture.expirationTasks.isEmpty());
        handler.handle("paste_image", "{\"requestId\":\"late\",\"snapshotId\":\"" + first + "\",\"scopeId\":\"draft-a\"}");
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
        assertTrue(handler.offerImagePaste(image()));
    }

    /** A scheduled hook read belongs to the draft at keyup, not whichever draft is current on the EDT. */
    @Test
    public void retiredHookReadDoesNotCaptureTheNextDraft() {
        Fixture fixture = new Fixture();
        AtomicInteger reads = new AtomicInteger();
        ClipboardHandler handler = fixture.handler(() -> {
            reads.incrementAndGet();
            return image();
        });
        handler.handle("paste_image_scope", "draft-a");
        handler.captureClipboardPaste();
        handler.handle("paste_image_scope", "draft-b");
        fixture.edtTasks.remove().run();
        assertEquals(0, reads.get());
        assertTrue(fixture.callback.scripts.isEmpty());
        assertTrue(handler.offerImagePaste(image()));
    }

    /** A window with no active input must not retain native images awaiting a nonexistent owner. */
    @Test
    public void noPublishedDraftRejectsNativeOffers() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = new ClipboardHandler(fixture.context, fixture.edtTasks::add,
                fixture.backgroundTasks::add, ClipboardHandlerTest::image, fixture::expireLater);
        assertTrue(!handler.offerImagePaste(image()));
        handler.captureClipboardPaste();
        assertTrue(fixture.edtTasks.isEmpty());
        assertTrue(fixture.expirationTasks.isEmpty());
    }

    /** A claim cannot attach a snapshot to a different draft even if its opaque snapshot id is known. */
    @Test
    public void mismatchedClaimScopeSettlesWithoutEncoding() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        assertTrue(handler.offerImagePaste(image()));
        String snapshotId = snapshotId(fixture.callback.scripts.get(0));
        fixture.callback.scripts.clear();
        handler.handle("paste_image", "{\"requestId\":\"wrong-draft\",\"snapshotId\":\"" + snapshotId + "\",\"scopeId\":\"draft-b\"}");
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertTrue(fixture.expirationTasks.isEmpty());
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
        assertTrue(handler.offerImagePaste(image()));
    }

    /** Unmounting an input must clear retained snapshots without waiting for their timeout. */
    @Test
    public void emptyScopeRetiresTheInputAndRejectsOversizedUpdates() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        handler.handle("paste_image_scope", "x".repeat(129));
        assertTrue(handler.offerImagePaste(image()));
        assertTrue(fixture.callback.scripts.get(0).contains("scopeId: \"draft-a\""));
        handler.handle("paste_image_scope", "");
        assertTrue(fixture.expirationTasks.isEmpty());
        assertTrue(!handler.offerImagePaste(image()));
        handler.dispose();
        handler.handle("paste_image_scope", "draft-c");
        assertTrue(!handler.offerImagePaste(image()));
    }

    /** Failed scheduling must not permanently consume the bounded admission slots. */
    @Test
    public void failedEncodingSchedulingReleasesAdmission() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = new ClipboardHandler(fixture.context, fixture.edtTasks::add,
                task -> { throw new java.util.concurrent.RejectedExecutionException("shutdown"); },
                ClipboardHandlerTest::image, fixture::expireLater);
        for (int index = 0; index < 5; index++) {
            handler.handle("paste_image", "rejected-" + index);
            assertEquals(1, fixture.edtTasks.size());
            fixture.edtTasks.remove().run();
        }
        assertEquals(5, fixture.callback.scripts.size());
    }

    /** Malformed snapshot claims must settle a valid request id instead of holding its draft for the timeout. */
    @Test
    public void invalidSnapshotClaimSettlesItsRequest() {
        Fixture fixture = new Fixture();
        fixture.handler(ClipboardHandlerTest::image).handle("paste_image", "{\"requestId\":\"invalid\"}");
        assertEquals(1, fixture.callback.scripts.size());
        assertTrue(fixture.callback.scripts.get(0).contains("requestId: \"invalid\""));
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
        assertTrue(fixture.edtTasks.isEmpty());
    }

    /** Request metadata must stay small even when the webview floods the bridge with invalid claims. */
    @Test
    public void rejectsOversizedImageRequestMetadataBeforeScheduling() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        handler.handle("paste_image", "{\"requestId\":\"" + "x".repeat(4096) + "\"}");
        assertTrue(fixture.edtTasks.isEmpty());
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertTrue(fixture.callback.scripts.isEmpty());
        handler.handle("paste_image", "valid-after-rejection");
        assertEquals(1, fixture.edtTasks.size());
    }

    /** Snapshot claims cannot retarget an image captured on an older browser page. */
    @Test
    public void snapshotReplyKeepsThePageOfItsGesture() {
        Fixture fixture = new Fixture();
        ClipboardHandler handler = fixture.handler(ClipboardHandlerTest::image);
        assertTrue(handler.offerImagePaste(image()));
        String snapshotId = snapshotId(fixture.callback.scripts.get(0));
        fixture.callback.scripts.clear();
        fixture.callback.page++;
        handler.handle("paste_image", "{\"requestId\":\"new-page\",\"snapshotId\":\"" + snapshotId + "\",\"scopeId\":\"draft-a\"}");
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** Dimensions must be bounded before allocating a converted raster, even for highly compressible images. */
    @Test
    public void rejectsOversizedRasterBeforeConversion() {
        Fixture fixture = new Fixture();
        Image oversized = new BaseMultiResolutionImage(image()) {
            @Override
            public int getWidth(ImageObserver observer) {
                return 16384;
            }

            @Override
            public int getHeight(ImageObserver observer) {
                return 16384;
            }
        };
        fixture.handler(() -> oversized).handle("paste_image", "oversized");
        fixture.edtTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
    }

    private static String snapshotId(String script) {
        Matcher matcher = Pattern.compile("snapshotId: \"([^\"]+)\"").matcher(script);
        assertTrue(matcher.find());
        return matcher.group(1);
    }

    /** An empty clipboard still settles the request so submission cannot stay disabled. */
    @Test
    public void emptyClipboardSettlesOwnedRequest() {
        Fixture fixture = new Fixture();
        fixture.handler(() -> null).handle("paste_image", "draft-request-2");
        fixture.edtTasks.remove().run();
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertEquals(1, fixture.callback.scripts.size());
        assertTrue(fixture.callback.scripts.get(0).contains("requestId: \"draft-request-2\""));
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
    }

    /** Failed image conversions must release the frontend's pending request as well. */
    @Test
    public void invalidImageSettlesOwnedRequest() {
        Fixture fixture = new Fixture();
        Image invalid = new BaseMultiResolutionImage(image()) {
            @Override
            public int getWidth(ImageObserver observer) {
                return -1;
            }
        };
        fixture.handler(() -> invalid).handle("paste_image", "draft-request-3");
        fixture.edtTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertEquals(1, fixture.callback.scripts.size());
        assertTrue(fixture.callback.scripts.get(0).contains("base64: null"));
    }

    /** Verifies dispatch only schedules the native read, then schedules encoding separately. */
    @Test
    public void readsOnScheduledEdtTaskAndEncodesOnBackgroundTask() throws Exception {
        Fixture fixture = new Fixture();
        AtomicInteger reads = new AtomicInteger();
        BufferedImage image = image();
        ClipboardHandler handler = fixture.handler(() -> {
            reads.incrementAndGet();
            return image;
        });

        assertTrue(handler.handle("paste_image", ""));
        assertEquals(0, reads.get());
        assertEquals(1, fixture.edtTasks.size());
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertEquals(1, fixture.callback.captures);

        fixture.edtTasks.remove().run();
        assertEquals(1, reads.get());
        assertEquals(1, fixture.backgroundTasks.size());
        assertTrue(fixture.callback.scripts.isEmpty());

        fixture.backgroundTasks.remove().run();
        assertPastedImage(fixture.callback.scripts, image);
    }

    /** Guards macOS multi-resolution images and keeps raster conversion off the read task. */
    @Test
    public void convertsNonBufferedImageOnlyOnBackgroundTask() throws Exception {
        Fixture fixture = new Fixture();
        AtomicInteger dimensionReads = new AtomicInteger();
        BufferedImage source = image();
        Image image = new BaseMultiResolutionImage(source) {
            @Override
            public int getWidth(ImageObserver observer) {
                dimensionReads.incrementAndGet();
                return super.getWidth(observer);
            }
        };
        ClipboardHandler handler = fixture.handler(() -> image);

        handler.handle("paste_image", "");
        fixture.edtTasks.remove().run();
        assertEquals("raster conversion must not run on the clipboard read task", 0, dimensionReads.get());
        fixture.backgroundTasks.remove().run();

        assertTrue(dimensionReads.get() > 0);
        assertPastedImage(fixture.callback.scripts, source);
    }

    /** Slow native reads and raster conversion must not prevent later dispatch or teardown. */
    @Test(timeout = 10000)
    public void blockedReadAndEncodingDoNotHoldDispatchGate() throws Exception {
        Fixture fixture = new Fixture();
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch readEntered = new CountDownLatch(1);
        CountDownLatch releaseRead = new CountDownLatch(1);
        CountDownLatch encodingEntered = new CountDownLatch(1);
        CountDownLatch releaseEncoding = new CountDownLatch(1);
        Image image = new BaseMultiResolutionImage(image()) {
            @Override
            public int getWidth(ImageObserver observer) {
                encodingEntered.countDown();
                await(releaseEncoding);
                return super.getWidth(observer);
            }
        };
        ClipboardHandler handler = fixture.handler(() -> {
            readEntered.countDown();
            await(releaseRead);
            return image;
        });
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            assertTrue(workers.submit(() -> gate.runInDispatch(() -> handler.handle("paste_image", "")))
                    .get(2, TimeUnit.SECONDS));
            Future<?> read = workers.submit(fixture.edtTasks.remove());
            assertTrue(readEntered.await(2, TimeUnit.SECONDS));
            assertTrue("a blocked native read must leave the gate free",
                    workers.submit(() -> gate.runInDispatch(() -> { })).get(2, TimeUnit.SECONDS));

            releaseRead.countDown();
            read.get(2, TimeUnit.SECONDS);
            Future<?> encoding = workers.submit(fixture.backgroundTasks.remove());
            assertTrue(encodingEntered.await(2, TimeUnit.SECONDS));
            assertTrue("a blocked encode must leave the gate free",
                    workers.submit(() -> gate.runInDispatch(() -> { })).get(2, TimeUnit.SECONDS));
            assertTrue("teardown must not wait for image encoding",
                    workers.submit(gate::beginTeardown).get(2, TimeUnit.SECONDS));
            fixture.context.setDisposed(true);
            releaseEncoding.countDown();
            encoding.get(2, TimeUnit.SECONDS);
            assertTrue("disposal during encoding must reject the reply", fixture.callback.scripts.isEmpty());
        } finally {
            releaseRead.countDown();
            releaseEncoding.countDown();
            workers.shutdownNow();
            workers.awaitTermination(2, TimeUnit.SECONDS);
        }
    }

    /** Empty clipboards do not start unnecessary encoding work or emit an image event. */
    @Test
    public void missingImageDoesNotScheduleEncoding() {
        Fixture fixture = new Fixture();
        fixture.handler(() -> null).handle("paste_image", "");
        fixture.edtTasks.remove().run();
        assertTrue(fixture.backgroundTasks.isEmpty());
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** Unloaded image dimensions must be rejected instead of allocating an invalid raster. */
    @Test
    public void rejectsInvalidImageDimensions() {
        Fixture fixture = new Fixture();
        Image image = new BaseMultiResolutionImage(image()) {
            @Override
            public int getWidth(ImageObserver observer) {
                return -1;
            }
        };
        fixture.handler(() -> image).handle("paste_image", "");
        fixture.edtTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** Work delayed until after window disposal must not touch the native clipboard. */
    @Test
    public void disposalBeforeReadSkipsClipboardAccess() {
        Fixture fixture = new Fixture();
        AtomicInteger reads = new AtomicInteger();
        fixture.handler(() -> {
            reads.incrementAndGet();
            return image();
        }).handle("paste_image", "");
        fixture.context.setDisposed(true);
        fixture.edtTasks.remove().run();
        assertEquals(0, reads.get());
        assertTrue(fixture.backgroundTasks.isEmpty());
    }

    /** A delayed reply must retain the page captured before the EDT read was scheduled. */
    @Test
    public void pageChangeBeforeReadRejectsDeferredReply() {
        Fixture fixture = new Fixture();
        fixture.handler(ClipboardHandlerTest::image).handle("paste_image", "");
        fixture.callback.page++;
        fixture.edtTasks.remove().run();
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** A browser replaced while PNG encoding is pending must not receive the old image. */
    @Test
    public void browserReplacementBeforeEncodingRejectsDeferredReply() {
        Fixture fixture = new Fixture();
        fixture.handler(ClipboardHandlerTest::image).handle("paste_image", "");
        fixture.edtTasks.remove().run();
        fixture.callback.browser = new Object();
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** A page switched after encoding completes must still reject the already encoded payload. */
    @Test
    public void pageChangeAfterEncodingRejectsDeferredReply() {
        Fixture fixture = new Fixture();
        fixture.handler(ClipboardHandlerTest::image).handle("paste_image", "");
        fixture.edtTasks.remove().run();
        fixture.callback.beforeDelivery = script -> {
            assertTrue("the payload must already be encoded", script.contains("base64: 'iVBOR"));
            fixture.callback.page++;
        };
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    /** Disposal between the native read and the background task must skip image conversion. */
    @Test
    public void disposalBeforeEncodingSkipsImageConversion() {
        Fixture fixture = new Fixture();
        Image image = new BaseMultiResolutionImage(image()) {
            @Override
            public int getWidth(ImageObserver observer) {
                fail("disposed work must not convert the image");
                return -1;
            }
        };
        fixture.handler(() -> image).handle("paste_image", "");
        fixture.edtTasks.remove().run();
        fixture.context.setDisposed(true);
        fixture.backgroundTasks.remove().run();
        assertTrue(fixture.callback.scripts.isEmpty());
    }

    private static BufferedImage image() {
        BufferedImage image = new BufferedImage(2, 3, BufferedImage.TYPE_INT_ARGB);
        image.setRGB(0, 0, 0xff123456);
        return image;
    }

    private static void assertPastedImage(List<String> scripts, BufferedImage expected) throws Exception {
        assertEquals(1, scripts.size());
        String script = scripts.get(0);
        assertTrue(script.contains("CustomEvent('java-paste-image'"));
        assertTrue(script.contains("mediaType: 'image/png'"));
        Matcher matcher = Pattern.compile("base64: '([^']+)'").matcher(script);
        assertTrue(matcher.find());
        byte[] png = Base64.getDecoder().decode(matcher.group(1));
        BufferedImage decoded = ImageIO.read(new ByteArrayInputStream(png));
        assertNotNull(decoded);
        assertEquals(expected.getWidth(), decoded.getWidth());
        assertEquals(expected.getHeight(), decoded.getHeight());
        assertEquals(expected.getRGB(0, 0), decoded.getRGB(0, 0));
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue("worker must be released", latch.await(5, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static final class Fixture {
        private final RecordingCallback callback = new RecordingCallback();
        private final HandlerContext context = new HandlerContext(null, null, null, null, callback);
        private final Queue<Runnable> edtTasks = new ConcurrentLinkedQueue<>();
        private final Queue<Runnable> backgroundTasks = new ConcurrentLinkedQueue<>();
        private final Queue<Runnable> expirationTasks = new ConcurrentLinkedQueue<>();

        private Runnable expireLater(Runnable task) {
            this.expirationTasks.add(task);
            return () -> this.expirationTasks.remove(task);
        }

        private ClipboardHandler handler(java.util.function.Supplier<Image> reader) {
            ClipboardHandler handler = new ClipboardHandler(this.context, this.edtTasks::add,
                    this.backgroundTasks::add, reader, this::expireLater);
            handler.handle("paste_image_scope", "draft-a");
            return handler;
        }
    }

    private static final class RecordingCallback implements HandlerContext.JsCallback {
        private final List<String> scripts = new ArrayList<>();
        private Object browser = new Object();
        private int page = 1;
        private int captures;
        private Consumer<String> beforeDelivery = ignored -> { };

        @Override
        public void callJavaScript(String functionName, String... args) {
            fail("image paste must use the captured raw-script sender");
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }

        @Override
        public void executeJavaScript(String script) {
            fail("deferred image paste must not target the current page at completion time");
        }

        @Override
        public Consumer<String> captureJavaScriptExecutor() {
            captures++;
            Object expectedBrowser = browser;
            int expectedPage = page;
            return script -> {
                beforeDelivery.accept(script);
                if (browser == expectedBrowser && page == expectedPage) {
                    scripts.add(script);
                }
            };
        }
    }
}
