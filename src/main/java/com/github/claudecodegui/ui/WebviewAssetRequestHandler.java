package com.github.claudecodegui.ui;

import com.intellij.openapi.diagnostic.Logger;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.callback.CefCallback;
import org.cef.handler.CefLoadHandler;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.handler.CefResourceHandler;
import org.cef.handler.CefResourceHandlerAdapter;
import org.cef.handler.CefResourceRequestHandler;
import org.cef.handler.CefResourceRequestHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.misc.IntRef;
import org.cef.misc.StringRef;
import org.cef.network.CefRequest;
import org.cef.network.CefResponse;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.zip.GZIPInputStream;

/**
 * Serves compressed, content-hashed webview chunks to Remote JCEF.
 *
 * <p>The small per-tab HTML document is still loaded through {@code loadHTML} so Java can inject
 * tab state. Large immutable assets use a stable origin, allowing the frontend Chromium process
 * to cache them across chat tabs instead of receiving the full bundle for every browser.</p>
 */
final class WebviewAssetRequestHandler extends CefRequestHandlerAdapter {

    static final String WEBVIEW_ASSET_ORIGIN = "https://cc-gui-webview.local";
    private static final String WEBVIEW_ASSET_HOST = "cc-gui-webview.local";
    private static final String ASSET_PATH_PREFIX = "/assets/";
    private static final String RESOURCE_PATH_PREFIX = "/webview/assets/";
    private static final Logger LOG = Logger.getInstance(WebviewAssetRequestHandler.class);
    private static final ConcurrentMap<String, Asset> ASSET_CACHE = new ConcurrentHashMap<>();

    private final CefResourceRequestHandler resourceRequestHandler =
            new CefResourceRequestHandlerAdapter() {
                @Override
                public CefResourceHandler getResourceHandler(
                        CefBrowser browser,
                        CefFrame frame,
                        CefRequest request
                ) {
                    Asset asset = loadAsset(request.getURL());
                    return asset != null
                            ? new AssetResourceHandler(asset)
                            : new MissingAssetResourceHandler();
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
        if (!isWebviewAssetUrl(request.getURL())) {
            return null;
        }
        disableDefaultHandling.set(true);
        return resourceRequestHandler;
    }

    static boolean isWebviewAssetUrl(String url) {
        URI uri = parseUri(url);
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && WEBVIEW_ASSET_HOST.equalsIgnoreCase(uri.getHost())
                && resourcePathForUrl(url) != null;
    }

    /** Maps only Vite's hashed asset namespace into the plugin classpath. */
    static String resourcePathForUrl(String url) {
        URI uri = parseUri(url);
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())
                || !WEBVIEW_ASSET_HOST.equalsIgnoreCase(uri.getHost())
                || uri.getRawUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) {
            return null;
        }
        String path = uri.getRawPath();
        if (path == null || !path.startsWith(ASSET_PATH_PREFIX) || path.endsWith("/")
                || path.contains("..") || path.contains("\\") || path.contains("//")
                || !path.matches("[A-Za-z0-9_./-]+")) {
            return null;
        }
        return RESOURCE_PATH_PREFIX + path.substring(ASSET_PATH_PREFIX.length());
    }

    static String mimeTypeForPath(String path) {
        String lowerPath = path.toLowerCase(Locale.ROOT);
        if (lowerPath.endsWith(".js")) { return "text/javascript"; }
        if (lowerPath.endsWith(".css")) { return "text/css"; }
        if (lowerPath.endsWith(".woff2")) { return "font/woff2"; }
        if (lowerPath.endsWith(".woff")) { return "font/woff"; }
        if (lowerPath.endsWith(".ttf")) { return "font/truetype"; }
        if (lowerPath.endsWith(".png")) { return "image/png"; }
        if (lowerPath.endsWith(".svg")) { return "image/svg+xml"; }
        return "application/octet-stream";
    }

    private static Asset loadAsset(String url) {
        String resourcePath = resourcePathForUrl(url);
        if (resourcePath == null) {
            return null;
        }
        return ASSET_CACHE.computeIfAbsent(resourcePath, WebviewAssetRequestHandler::readAsset);
    }

    private static Asset readAsset(String resourcePath) {
        boolean storedCompressed = resourcePath.endsWith(".js") || resourcePath.endsWith(".css");
        String storedPath = storedCompressed ? resourcePath + ".gz" : resourcePath;
        try (InputStream stream = WebviewAssetRequestHandler.class.getResourceAsStream(storedPath)) {
            if (stream == null) {
                return null;
            }
            // Remote JCEF forwards handler bodies over RD. Decompress here because its resource
            // bridge does not reliably preserve HTTP content decoding on the frontend Chromium.
            byte[] data = storedCompressed
                    ? new GZIPInputStream(stream).readAllBytes()
                    : stream.readAllBytes();
            return new Asset(data, mimeTypeForPath(resourcePath));
        } catch (IOException e) {
            LOG.warn("[WebviewAsset] Failed to read plugin resource: " + storedPath, e);
            return null;
        }
    }

    private static URI parseUri(String url) {
        if (url == null || url.isEmpty()) {
            return null;
        }
        try {
            return URI.create(url);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private record Asset(byte[] data, String mimeType) {
    }

    private static final class AssetResourceHandler extends CefResourceHandlerAdapter {
        private final Asset asset;
        private int offset;

        private AssetResourceHandler(Asset asset) {
            this.asset = asset;
        }

        @Override
        public boolean processRequest(CefRequest request, CefCallback callback) {
            callback.Continue();
            return true;
        }

        @Override
        public void getResponseHeaders(
                CefResponse response,
                IntRef responseLength,
                StringRef redirectUrl
        ) {
            response.setStatus(200);
            response.setStatusText("OK");
            response.setMimeType(asset.mimeType());
            response.setHeaderByName("Cache-Control", "private, max-age=31536000, immutable", true);
            response.setHeaderByName("Access-Control-Allow-Origin", "*", true);
            response.setHeaderByName("X-Content-Type-Options", "nosniff", true);
            responseLength.set(asset.data().length);
        }

        @Override
        public boolean readResponse(
                byte[] dataOut,
                int bytesToRead,
                IntRef bytesRead,
                CefCallback callback
        ) {
            int remaining = asset.data().length - offset;
            if (remaining <= 0) {
                bytesRead.set(0);
                return false;
            }
            int count = Math.min(Math.min(bytesToRead, dataOut.length), remaining);
            System.arraycopy(asset.data(), offset, dataOut, 0, count);
            offset += count;
            bytesRead.set(count);
            return true;
        }
    }

    private static final class MissingAssetResourceHandler extends CefResourceHandlerAdapter {
        @Override
        public boolean processRequest(CefRequest request, CefCallback callback) {
            callback.Continue();
            return true;
        }

        @Override
        public void getResponseHeaders(
                CefResponse response,
                IntRef responseLength,
                StringRef redirectUrl
        ) {
            response.setStatus(404);
            response.setStatusText("Not Found");
            response.setError(CefLoadHandler.ErrorCode.ERR_FILE_NOT_FOUND);
            responseLength.set(0);
        }

        @Override
        public boolean readResponse(
                byte[] dataOut,
                int bytesToRead,
                IntRef bytesRead,
                CefCallback callback
        ) {
            bytesRead.set(0);
            return false;
        }
    }
}
