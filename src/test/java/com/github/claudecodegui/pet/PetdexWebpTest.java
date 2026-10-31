package com.github.claudecodegui.pet;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import java.lang.reflect.Field;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Flow;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertTrue;

public class PetdexWebpTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void downloadsWebpPreviewWithoutGlobalWebpProvider() throws Exception {
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            PetdexRepository repository = new PetdexRepository(new FixtureClient(fixture.sheet()));
            assertTrue(repository.getPreviewDataUrl("webp-pet").startsWith("data:image/png;base64,"));
            fixture.assertRegistryUnchanged();
        }
    }

    @Test
    public void installsWebpSheetWithoutGlobalWebpProvider() throws Exception {
        Field home = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        home.setAccessible(true);
        Object previousHome = home.get(null);
        Path isolatedHome = temporary.newFolder("home").toPath();
        try (WebpTestFixture fixture = new WebpTestFixture()) {
            home.set(null, isolatedHome.toString());
            byte[] sheet = fixture.sheet();
            PetdexRepository repository = new PetdexRepository(new FixtureClient(sheet));
            PetdexRepository.InstallResult installed = repository.install("webp-pet");
            Path image = isolatedHome.resolve(".codex/pets").resolve(installed.getPetId());
            assertArrayEquals(sheet, Files.readAllBytes(image));
            assertTrue(Files.isRegularFile(image.getParent().resolve("pet.json")));
            fixture.assertRegistryUnchanged();
        } finally {
            home.set(null, previousHome);
        }
    }

    /** Drives the real bounded response subscriber with deterministic, offline responses. */
    private static final class FixtureClient extends HttpClient {
        private final HttpClient defaults = HttpClient.newHttpClient();
        private final byte[] sheet;

        private FixtureClient(byte[] sheet) {
            this.sheet = sheet;
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
            byte[] bytes;
            if (request.uri().getPath().endsWith(".webp")) {
                bytes = sheet;
            } else if (request.uri().getPath().endsWith("pet.json")) {
                bytes = "{\"displayName\":\"WebP fixture\"}".getBytes(StandardCharsets.UTF_8);
            } else {
                bytes = ("{\"pets\":[{\"slug\":\"webp-pet\",\"displayName\":\"WebP\","
                        + "\"spritesheetUrl\":\"https://assets.petdex.dev/pets/webp-pet/sprite.webp\","
                        + "\"petJsonUrl\":\"https://assets.petdex.dev/pets/webp-pet/pet.json\"}]}").getBytes(StandardCharsets.UTF_8);
            }
            HttpResponse.BodySubscriber<T> subscriber = handler.apply(new HttpResponse.ResponseInfo() {
                public int statusCode() { return 200; }
                public HttpHeaders headers() { return HttpHeaders.of(Map.of(), (key, value) -> true); }
                public Version version() { return Version.HTTP_1_1; }
            });
            subscriber.onSubscribe(new Flow.Subscription() {
                public void request(long count) { }
                public void cancel() { }
            });
            subscriber.onNext(List.of(ByteBuffer.wrap(bytes)));
            subscriber.onComplete();
            return subscriber.getBody().toCompletableFuture().thenApply(body -> new FixtureResponse<>(request, body));
        }

        @Override public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
            return sendAsync(request, handler).join();
        }
        @Override public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
                HttpResponse.BodyHandler<T> handler, HttpResponse.PushPromiseHandler<T> push) {
            return sendAsync(request, handler);
        }
        @Override public Optional<CookieHandler> cookieHandler() { return defaults.cookieHandler(); }
        @Override public Optional<Duration> connectTimeout() { return defaults.connectTimeout(); }
        @Override public Redirect followRedirects() { return defaults.followRedirects(); }
        @Override public Optional<ProxySelector> proxy() { return defaults.proxy(); }
        @Override public SSLContext sslContext() { return defaults.sslContext(); }
        @Override public SSLParameters sslParameters() { return defaults.sslParameters(); }
        @Override public Optional<Authenticator> authenticator() { return defaults.authenticator(); }
        @Override public Version version() { return defaults.version(); }
        @Override public Optional<Executor> executor() { return defaults.executor(); }
    }

    private record FixtureResponse<T>(HttpRequest request, T body) implements HttpResponse<T> {
        @Override public int statusCode() { return 200; }
        @Override public Optional<HttpResponse<T>> previousResponse() { return Optional.empty(); }
        @Override public HttpHeaders headers() { return HttpHeaders.of(Map.of(), (key, value) -> true); }
        @Override public Optional<SSLSession> sslSession() { return Optional.empty(); }
        @Override public URI uri() { return request.uri(); }
        @Override public HttpClient.Version version() { return HttpClient.Version.HTTP_1_1; }
    }
}
