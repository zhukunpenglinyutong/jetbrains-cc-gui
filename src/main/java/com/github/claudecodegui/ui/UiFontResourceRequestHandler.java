package com.github.claudecodegui.ui;

import com.github.claudecodegui.util.UiFontResourceService;
import com.intellij.openapi.diagnostic.Logger;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefResourceHandler;
import org.cef.handler.CefResourceRequestHandler;
import org.cef.handler.CefResourceRequestHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.misc.IntRef;
import org.cef.misc.StringRef;
import org.cef.network.CefRequest;
import org.cef.network.CefResponse;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;

/**
 * Serves registered custom UI font files directly to Chromium without embedding them in JS.
 */
final class UiFontResourceRequestHandler extends CefRequestHandlerAdapter {

    private static final Logger LOG = Logger.getInstance(UiFontResourceRequestHandler.class);

    private final CefResourceRequestHandler resourceRequestHandler = new CefResourceRequestHandlerAdapter() {
        @Override
        public CefResourceHandler getResourceHandler(
                CefBrowser browser,
                CefFrame frame,
                CefRequest request
        ) {
            UiFontResourceService.FontResource resource =
                    UiFontResourceService.resolveFontUrl(request.getURL());
            return resource != null ? new FontResourceHandler(resource) : new MissingFontResourceHandler();
        }
    };

    @Override
    public CefResourceRequestHandler getResourceRequestHandler(
            CefBrowser browser,
            CefFrame frame,
            CefRequest request,
            boolean isNavigation,
            boolean isDownload,
            String requestInitiator,
            BoolRef disableDefaultHandling
    ) {
        if (!UiFontResourceService.isUiFontUrl(request.getURL())) {
            return null;
        }

        disableDefaultHandling.set(true);
        return resourceRequestHandler;
    }

    private static final class FontResourceHandler implements CefResourceHandler {
        private final UiFontResourceService.FontResource resource;
        private InputStream stream;

        private FontResourceHandler(UiFontResourceService.FontResource resource) {
            this.resource = resource;
        }

        @Override
        public boolean processRequest(CefRequest request, CefCallback callback) {
            try {
                stream = Files.newInputStream(resource.path());
                callback.Continue();
                return true;
            } catch (IOException e) {
                LOG.warn("[UiFontResource] Failed to open font resource: " + resource.path(), e);
                return false;
            }
        }

        @Override
        public void getResponseHeaders(CefResponse response, IntRef responseLength, StringRef redirectUrl) {
            response.setStatus(200);
            response.setStatusText("OK");
            response.setMimeType(resource.mimeType());
            response.setHeaderByName("Cache-Control", "private, max-age=31536000, immutable", true);
            response.setHeaderByName("Access-Control-Allow-Origin", "*", true);
            responseLength.set(resource.length() <= Integer.MAX_VALUE ? (int) resource.length() : -1);
        }

        @Override
        public boolean readResponse(byte[] dataOut, int bytesToRead, IntRef bytesRead, CefCallback callback) {
            if (stream == null) {
                bytesRead.set(0);
                return false;
            }

            try {
                int bytesReadNow = stream.read(dataOut, 0, Math.min(bytesToRead, dataOut.length));
                if (bytesReadNow > 0) {
                    bytesRead.set(bytesReadNow);
                    return true;
                }
            } catch (IOException e) {
                LOG.warn("[UiFontResource] Failed while streaming font resource: " + resource.path(), e);
            }

            closeStream();
            bytesRead.set(0);
            return false;
        }

        @Override
        public void cancel() {
            closeStream();
        }

        private void closeStream() {
            if (stream == null) {
                return;
            }
            try {
                stream.close();
            } catch (IOException e) {
                LOG.debug("[UiFontResource] Failed to close font stream: " + e.getMessage());
            } finally {
                stream = null;
            }
        }
    }

    private static final class MissingFontResourceHandler implements CefResourceHandler {
        @Override
        public boolean processRequest(CefRequest request, CefCallback callback) {
            callback.Continue();
            return true;
        }

        @Override
        public void getResponseHeaders(CefResponse response, IntRef responseLength, StringRef redirectUrl) {
            response.setStatus(404);
            response.setStatusText("Not Found");
            response.setError(CefLoadHandler.ErrorCode.ERR_FILE_NOT_FOUND);
            responseLength.set(0);
        }

        @Override
        public boolean readResponse(byte[] dataOut, int bytesToRead, IntRef bytesRead, CefCallback callback) {
            bytesRead.set(0);
            return false;
        }

        @Override
        public void cancel() {
        }
    }
}
