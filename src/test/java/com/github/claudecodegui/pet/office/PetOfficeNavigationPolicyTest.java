package com.github.claudecodegui.pet.office;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PetOfficeNavigationPolicyTest {
    private static final String ENTRY = "http://127.0.0.1/ccgui-pet-office/test-page.html";

    @Test
    public void admitsAndPinsThePlatformHtmlWrapper() {
        PetOfficeNavigationPolicy policy = new PetOfficeNavigationPolicy(ENTRY);
        String wrapper = "file:///jbcefbrowser/1583780035#url=" + ENTRY;
        assertTrue(policy.allows(ENTRY, true));
        assertTrue(policy.allows(wrapper, true));
        assertTrue(policy.allows(wrapper, true));
        assertFalse(policy.allows("file:///jbcefbrowser/42#url=" + ENTRY, true));
    }

    @Test
    public void rejectsFilesOtherPagesAndSubframesWithoutPinningThem() {
        PetOfficeNavigationPolicy policy = new PetOfficeNavigationPolicy(ENTRY);
        assertFalse(policy.allows(ENTRY, false));
        assertFalse(policy.allows("file:///jbcefbrowser/1#url=" + ENTRY, false));
        assertFalse(policy.allows("file:///jbcefbrowser/1#url=" + ENTRY + "-other", true));
        assertFalse(policy.allows("file:///C:/private-file#url=" + ENTRY, true));
        assertFalse(policy.allows("https://example.invalid/", true));
        assertFalse(policy.allows("file:///jbcefbrowser/../1#url=" + ENTRY, true));
        assertFalse(policy.allows("file://remote/jbcefbrowser/1#url=" + ENTRY, true));
        assertFalse(policy.allows("file:///jbcefbrowser/01#url=" + ENTRY, true));
        assertFalse(policy.allows("file:///jbcefbrowser/1?other#url=" + ENTRY, true));
        assertFalse(policy.allows(null, true));
        assertTrue(policy.allows("file:///jbcefbrowser/-2#url=" + ENTRY, true));
    }

    @Test
    public void stalePageAndOversizedValuesCannotAuthorizeNavigation() {
        PetOfficeNavigationPolicy policy = new PetOfficeNavigationPolicy(ENTRY);
        assertFalse(policy.allows("file:///jbcefbrowser/1#url=" + ENTRY.replace("test-page", "stale-page"), true));
        assertFalse(policy.allows("file:///jbcefbrowser/" + "1".repeat(5000) + "#url=" + ENTRY, true));
        assertTrue(policy.allows("file:///jbcefbrowser/1#url=" + ENTRY, true));
    }
}
