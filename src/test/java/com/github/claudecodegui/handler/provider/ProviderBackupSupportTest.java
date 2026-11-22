package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.settings.ProviderBackupService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;
import java.util.stream.IntStream;

import static org.junit.Assert.assertEquals;

public class ProviderBackupSupportTest {
    @Test
    public void exportSummaryCarriesOnlyCountsAndCappedPositions() {
        JsonObject payload = JsonParser.parseString("{\"providers\":[{\"name\":\"private-name\"},{\"name\":\"other\"}]}")
                .getAsJsonObject();
        List<Integer> skipped = IntStream.rangeClosed(3, 32).boxed().toList();
        JsonObject summary = ProviderBackupSupport.exportSummary(new ProviderBackupService.ExportResult(payload, skipped));
        JsonArray expectedPositions = new JsonArray();
        IntStream.rangeClosed(3, 22).forEach(expectedPositions::add);
        assertEquals(2, summary.get("exported").getAsInt());
        assertEquals(30, summary.get("skipped").getAsInt());
        assertEquals(expectedPositions, summary.getAsJsonArray("skippedProviders"));
        assertEquals(3, summary.size());
    }

    @Test
    public void exportSummaryWithoutSkippedProvidersHasAnEmptyPositionList() {
        JsonObject payload = JsonParser.parseString("{\"providers\":[{\"name\":\"a\"}]}").getAsJsonObject();
        JsonObject summary = ProviderBackupSupport.exportSummary(new ProviderBackupService.ExportResult(payload, List.of()));
        assertEquals(1, summary.get("exported").getAsInt());
        assertEquals(0, summary.get("skipped").getAsInt());
        assertEquals(new JsonArray(), summary.getAsJsonArray("skippedProviders"));
    }
}
