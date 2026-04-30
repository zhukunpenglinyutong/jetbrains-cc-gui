package com.github.claudecodegui.action.editor;

import org.junit.Assert;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicReference;

public class SelectionReferenceFailureHandlerTest {

    @Test
    public void selectCodeFirstUsesCustomInfoMessageKey() {
        AtomicReference<String> infoMessage = new AtomicReference<>();
        AtomicReference<String> errorMessage = new AtomicReference<>();

        SelectionReferenceFailureHandler.showBuildFailure(
                SelectionReferenceBuilder.Result.failure("send.selectCodeFirst"),
                "action.copyAiReference.selectCodeFirst",
                infoMessage::set,
                errorMessage::set
        );

        Assert.assertEquals("Please select code to copy first", infoMessage.get());
        Assert.assertNull(errorMessage.get());
    }

    @Test
    public void nonSelectCodeFirstStillUsesErrorRouting() {
        AtomicReference<String> infoMessage = new AtomicReference<>();
        AtomicReference<String> errorMessage = new AtomicReference<>();

        SelectionReferenceFailureHandler.showBuildFailure(
                SelectionReferenceBuilder.Result.failure("send.cannotGetFilePath"),
                "action.copyAiReference.selectCodeFirst",
                infoMessage::set,
                errorMessage::set
        );

        Assert.assertNull(infoMessage.get());
        Assert.assertEquals("Cannot determine file path", errorMessage.get());
    }
}
