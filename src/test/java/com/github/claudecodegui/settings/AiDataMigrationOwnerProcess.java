package com.github.claudecodegui.settings;

import java.nio.file.Path;

/** Real coordinator participant used only with disposable test directories. */
public final class AiDataMigrationOwnerProcess {
    public static void main(String[] args) throws Exception {
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(Path.of(args[0]));
        System.out.println("READY");
        System.out.flush();
        System.in.read();
        if (args.length > 1 && "cancel".equals(args[1])) {
            coordinator.requestMigrationCancellation();
            System.out.println("CANCELLED");
            System.out.flush();
            return;
        }
        try (AiDataMigrationCoordinator.LockHandle permit = coordinator.tryAcquire("migrate")) {
            System.out.println(permit == null ? "BUSY" : "OWNED");
            System.out.flush();
            if (permit != null) {
                System.in.read();
            }
        }
    }
}
