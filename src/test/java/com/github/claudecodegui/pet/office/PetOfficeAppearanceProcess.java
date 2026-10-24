package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;
import com.google.gson.Gson;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/** Controlled child process: only test artwork, private pipes and mode acknowledgements. */
public final class PetOfficeAppearanceProcess {
    private PetOfficeAppearanceProcess() { }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        var process = ProcessHandle.current();
        var member = new PetOfficeModeStore.Member(java.util.UUID.randomUUID().toString(), process.pid(), process.info().startInstant().orElseThrow().toEpochMilli(), "");
        var modes = new PetOfficeModeStore(root); modes.register(member);
        var config = new VisualConfiguration("pet.png", "project", 1, PetOfficeAppearanceService.defaultConfiguration().actionMappings(), 0);
        var snapshot = PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1);
        var publisher = new PetOfficeAppearancePublisher(() -> snapshot, ignored -> config, new PetOfficeAppearanceService(root, () -> () -> { }));
        try (var channel = new PetOfficeAssetChannel("pycharm", publisher)) {
            System.out.println(new Gson().toJson(PetOfficeAppearanceCodec.endpoint(channel.endpoint())));
            var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            for (String command; (command = input.readLine()) != null;) {
                if (command.equals("ACK")) {
                    var mode = modes.read(); modes.register(new PetOfficeModeStore.Member(member.id(), member.pid(), member.startedAt(), mode.epoch()));
                    System.out.println("ACKNOWLEDGED");
                } else if (command.equals("RETIRE")) {
                    modes.retire(member); System.out.println("RETIRED");
                } else {
                    throw new IllegalArgumentException("Unknown fixture instruction");
                }
            }
        }
    }
}
