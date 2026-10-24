package com.github.claudecodegui.pet.office;

import java.nio.file.Path;

/** Controlled IPC fixture, never an IDE or native window. Only its parent test may stop this process. */
public final class PetOfficeRoutingProcess {
    private PetOfficeRoutingProcess() { }

    public static void main(String[] arguments) throws Exception {
        Path root = Path.of(arguments[0]);
        if (arguments[1].equals("participant")) {
            participant(root);
        } else {
            owner(root, arguments[1].equals("explicit"));
        }
    }

    private static void participant(Path root) throws Exception {
        var endpoint = new PetOfficeEndpointStore(root).read();
        try (var client = new PetOfficeIpcClient(endpoint, "pycharm")) {
            client.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1));
            System.out.println("PUBLISHED"); System.out.flush();
            while (true) {
                for (var command : client.poll()) {
                    client.complete(command, PetOfficeTabNavigator.Result.ATTENTION_REQUESTED);
                    System.out.println("ROUTED"); System.out.flush();
                }
                Thread.sleep(25);
            }
        }
    }

    private static void owner(Path root, boolean explicit) throws Exception {
        var recovery = new PetOfficeRecoveryStore(root);
        var expected = recovery.read();
        if (!explicit && (expected == null || !expected.enabled())) {
            System.out.println("DISABLED"); System.out.flush(); return;
        }
        var acquired = PetOfficeRuntimeLease.tryAcquire(root);
        if (acquired.isEmpty()) {
            System.out.println("OCCUPIED"); System.out.flush(); return;
        }
        try (var lease = acquired.get();
             var server = new PetOfficeIpcServer("fixture-owner", new PetOfficeParticipantRegistry(), lease::isValid, () -> { })) {
            var endpoints = new PetOfficeEndpointStore(root);
            var intent = recovery.adopt(server.endpoint().leaderEpoch(), expected, explicit, lease);
            endpoints.publish(server.endpoint(), lease);
            System.out.println(intent.visible() ? "SHOWN" : "HIDDEN"); System.out.flush();
            var input = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, java.nio.charset.StandardCharsets.UTF_8));
            for (String command; (command = input.readLine()) != null;) {
                if (command.equals("HIDE")) {
                    recovery.write(server.endpoint().leaderEpoch(), true, false, lease);
                    System.out.println("HIDDEN");
                } else if (command.equals("CLOSE")) {
                    recovery.write(server.endpoint().leaderEpoch(), false, false, lease);
                    System.out.println("CLOSING");
                } else if (command.equals("DISPOSED")) {
                    server.close(); endpoints.removeOwned(server.endpoint(), lease);
                    System.out.println("RELEASED"); System.out.flush(); return;
                }
                System.out.flush();
            }
        }
    }
}
