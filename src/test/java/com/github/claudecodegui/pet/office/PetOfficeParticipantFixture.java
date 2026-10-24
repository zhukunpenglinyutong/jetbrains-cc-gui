package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;

import java.util.ArrayList;
import java.util.List;

final class PetOfficeParticipantFixture {
    private PetOfficeParticipantFixture() { }

    static PetOfficeSessionRegistry.CompleteSnapshot snapshot(String owner, int count, long watermark, long observation) {
        List<PetOfficeSessionRegistry.SourceSnapshot> sources = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String content = "tab-" + i;
            String binding = "binding-" + i;
            var key = new PetOfficeSessionRegistry.SourceKey(owner, content, binding);
            var metadata = new PetOfficeSessionRegistry.Metadata(content, owner, owner, "project-" + owner + "-" + i / 2, "project " + owner, "AI1");
            var execution = new SessionExecutionState.Snapshot(binding, "turn-" + i, SessionExecutionState.Phase.RUNNING,
                    SessionExecutionState.WaitReason.NONE, "", 0, SessionExecutionState.Outcome.NONE, "", 1, 0, watermark);
            sources.add(new PetOfficeSessionRegistry.SourceSnapshot(key, watermark, metadata, "codex", "model", execution,
                    PetOfficeSessionRegistry.RouteStatus.AVAILABLE, "route-" + i, observation, 0, 0));
        }
        return new PetOfficeSessionRegistry.CompleteSnapshot(1, owner, "local-epoch", watermark, 1, sources, List.of(), false);
    }

    static byte[] bytes(PetOfficeParticipantRegistry.Connection connection, int count, long watermark, long observation) throws java.io.IOException {
        return PetOfficeParticipantSnapshotCodec.encode(snapshot(connection.instanceId(), count, watermark, observation), connection.epoch());
    }
}
