package com.github.claudecodegui.pet.office;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.junit.Assert.*;

public class PetOfficeIpcFrameCodecTest {
    @Test
    public void lengthGuardRejectsBeforeReadingTheBody() throws Exception {
        for (int length : new int[]{-1, 0, 65537, Integer.MAX_VALUE}) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            new DataOutputStream(bytes).writeInt(length);
            IOException error = assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.read(new ByteArrayInputStream(bytes.toByteArray())));
            assertEquals("OFFICE_IPC_FRAME_CAPACITY", error.getMessage());
        }
    }

    @Test
    public void duplicateFieldsDepthInvalidUtf8AndTrailingDataAreRejected() {
        for (String value : new String[]{"{\"type\":\"HELLO\",\"type\":\"WINDOW_SHOW\"}", "{\"nested\":" + "[".repeat(34) + "0" + "]".repeat(34) + "}",
                "{\"field\":null}", "{}{}", "{field:1}"}) {
            assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(value.getBytes(StandardCharsets.UTF_8)));
        }
        assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(new byte[]{'{', '"', (byte) 0xC0, '"', ':', '1', '}'}));
    }

    @Test
    public void integerFieldsRejectFractionsStringsAndLargeExponentsWithoutRounding() throws Exception {
        for (String number : new String[]{"1.5", "\"1\"", "-1", "1e99999999", "9007199254740992"}) {
            var value = PetOfficeIpcFrameCodec.parse(("{\"number\":" + number + "}").getBytes(StandardCharsets.UTF_8));
            assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.integer(value, "number", 9_007_199_254_740_991L));
        }
    }

    @Test
    public void onlyThePreferenceAppearanceMapAdmitsLongSessionKeysAndMoreThan32Entries() throws Exception {
        var overrides = new com.google.gson.JsonObject();
        String longestKey = "i".repeat(128) + "/" + "t".repeat(128) + "/" + "b".repeat(128);
        overrides.addProperty(longestKey, "builtin");
        for (int index = 1; index < 256; index++) {
            overrides.addProperty("ide/tab/binding-" + index, "builtin");
        }
        String admitted = "{\"preferences\":{\"appearanceOverrides\":" + overrides + "}}";
        assertEquals(256, PetOfficeIpcFrameCodec.parse(admitted.getBytes(StandardCharsets.UTF_8))
                .getAsJsonObject("preferences").getAsJsonObject("appearanceOverrides").size());
        String duplicate = "{\"preferences\":{\"appearanceOverrides\":{\"" + longestKey + "\":\"builtin\",\"" + longestKey + "\":\"builtin\"}}}";
        assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(duplicate.getBytes(StandardCharsets.UTF_8)));
        for (String rejected : new String[]{overrides.toString(), "{\"appearanceOverrides\":" + overrides + "}",
                "{\"nested\":{\"preferences\":{\"appearanceOverrides\":" + overrides + "}}}"}) {
            assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(rejected.getBytes(StandardCharsets.UTF_8)));
        }
        overrides.addProperty("ide/tab/overflow", "builtin");
        String tooMany = "{\"preferences\":{\"appearanceOverrides\":" + overrides + "}}";
        assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(tooMany.getBytes(StandardCharsets.UTF_8)));
        String tooLong = "{\"preferences\":{\"appearanceOverrides\":{\"" + longestKey + "x\":\"builtin\"}}}";
        assertThrows(IOException.class, () -> PetOfficeIpcFrameCodec.parse(tooLong.getBytes(StandardCharsets.UTF_8)));
    }
}
