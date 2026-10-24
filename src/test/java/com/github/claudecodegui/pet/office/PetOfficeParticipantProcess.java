package com.github.claudecodegui.pet.office;

import java.nio.file.Path;

/** Controlled process fixture. Endpoint secrets are read from the private file, never command arguments. */
public final class PetOfficeParticipantProcess {
    private PetOfficeParticipantProcess() { }

    public static void main(String[] arguments) throws Exception {
        var endpoint = new PetOfficeEndpointStore(Path.of(arguments[0])).read();
        if (endpoint == null) {
            throw new IllegalStateException("Controlled endpoint is missing");
        }
        try (var client = new PetOfficeIpcClient(endpoint, arguments[1])) {
            client.publish(PetOfficeParticipantFixture.snapshot(arguments[1], 2, 1, 1));
            client.show();
            System.out.println("PUBLISHED");
            System.out.flush();
            while (System.in.read() != -1) {
                client.heartbeat();
            }
        }
    }
}
