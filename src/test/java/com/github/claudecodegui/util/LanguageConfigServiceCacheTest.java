package com.github.claudecodegui.util;

import org.junit.Test;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class LanguageConfigServiceCacheTest {

    private static String withCountingReader(AtomicInteger reads, java.util.function.Supplier<String> value) {
        return LanguageConfigService.userLanguageWithCache(() -> {
            reads.incrementAndGet();
            return value.get();
        });
    }

    private static String withFailingReader(AtomicInteger reads) {
        return LanguageConfigService.userLanguageWithCache(() -> {
            reads.incrementAndGet();
            throw new RuntimeException("disk unavailable");
        });
    }

    @Test
    public void cachesThePreferenceUntilInvalidated() {
        LanguageConfigService.invalidateUserLanguageCache();
        try {
            AtomicInteger reads = new AtomicInteger();
            assertEquals("zh", withCountingReader(reads, () -> "zh"));
            assertEquals("zh", withCountingReader(reads, () -> "zh"));
            assertEquals(1, reads.get());
            LanguageConfigService.invalidateUserLanguageCache();
            assertNull(withCountingReader(reads, () -> null));
            assertEquals(2, reads.get());
            assertNull(withCountingReader(reads, () -> null));
            assertEquals(2, reads.get());
        } finally {
            LanguageConfigService.invalidateUserLanguageCache();
        }
    }

    @Test
    public void rereadsAfterTheTtlSoAChangeFromAnotherIdeShowsUp() {
        LanguageConfigService.invalidateUserLanguageCache();
        try {
            AtomicInteger reads = new AtomicInteger();
            long ttl = LanguageConfigService.USER_LANGUAGE_CACHE_TTL_MS;
            assertEquals("zh", LanguageConfigService.userLanguageWithCache(() -> { reads.incrementAndGet(); return "zh"; }, 0));
            assertEquals("zh", LanguageConfigService.userLanguageWithCache(() -> { reads.incrementAndGet(); return "en"; }, ttl - 1));
            assertEquals(1, reads.get());
            assertEquals("en", LanguageConfigService.userLanguageWithCache(() -> { reads.incrementAndGet(); return "en"; }, ttl));
            assertEquals(2, reads.get());
        } finally {
            LanguageConfigService.invalidateUserLanguageCache();
        }
    }

    @Test
    public void doesNotCacheTransientReadFailures() {
        LanguageConfigService.invalidateUserLanguageCache();
        try {
            AtomicInteger reads = new AtomicInteger();
            assertNull(withFailingReader(reads));
            assertEquals(1, reads.get());
            assertNull(withFailingReader(reads));
            assertEquals(2, reads.get());
            assertEquals("en", withCountingReader(reads, () -> "en"));
            assertEquals(3, reads.get());
        } finally {
            LanguageConfigService.invalidateUserLanguageCache();
        }
    }

    @Test
    public void doesNotCacheAValueReadWhileThePreferenceWasRewritten() {
        LanguageConfigService.invalidateUserLanguageCache();
        try {
            AtomicInteger reads = new AtomicInteger();
            // A write lands (and invalidates) while this read is still returning the old value.
            assertEquals("zh", withCountingReader(reads, () -> {
                LanguageConfigService.invalidateUserLanguageCache();
                return "zh";
            }));
            assertEquals("en", withCountingReader(reads, () -> "en"));
            assertEquals(2, reads.get());
        } finally {
            LanguageConfigService.invalidateUserLanguageCache();
        }
    }

    @Test
    public void treatsUnsupportedValuesAsAbsentAndCachesThem() {
        LanguageConfigService.invalidateUserLanguageCache();
        try {
            AtomicInteger reads = new AtomicInteger();
            assertNull(withCountingReader(reads, () -> "xx-INVALID"));
            assertEquals(1, reads.get());
            assertNull(withCountingReader(reads, () -> "xx-INVALID"));
            assertEquals(1, reads.get());
        } finally {
            LanguageConfigService.invalidateUserLanguageCache();
        }
    }
}
