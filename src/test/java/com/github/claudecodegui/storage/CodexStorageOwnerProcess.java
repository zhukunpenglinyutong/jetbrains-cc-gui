package com.github.claudecodegui.storage;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.settings.AiDataMigrationCoordinator;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Isolated owner for real process death tests. It only receives disposable fixture paths. */
public final class CodexStorageOwnerProcess {
    private CodexStorageOwnerProcess() { }

    public static void main(String[] arguments) throws Exception {
        Path root = Path.of(arguments[0]);
        Path coordination = root.getParent().resolve("coordination");
        if (arguments[1].equals("wal")) {
            var connection = CodexStorageDatabase.open(root.resolve(CodexStoragePaths.HISTORY_DATABASE), false);
            CodexStorageDatabase.execute(connection, "PRAGMA journal_mode=WAL");
            CodexStorageDatabase.execute(connection, "PRAGMA wal_autocheckpoint=0");
            CodexStorageDatabase.execute(connection, "UPDATE thread_items SET item_json='{\"type\":\"agentMessage\",\"text\":\"committed WAL\"}' WHERE thread_id='keep'");
            Runtime.getRuntime().halt(78);
        }
        if (arguments[1].equals("writer")) {
            Path lock = Files.createDirectories(root.resolve("thread-writer-locks")).resolve("remove.lock");
            try (var lease = CodexStorageFileLock.tryAcquire(new CodexStoragePaths(root), lock, true)) {
                if (lease == null) {
                    throw new IllegalStateException("Unexpected native writer owner");
                }
                System.out.println("WRITER_READY");
                System.out.flush();
                System.in.read();
            }
            return;
        }
        if (arguments[1].equals("admit")) {
            try (var permit = new AiDataMigrationCoordinator(coordination).tryAcquireProcessLock()) {
                if (permit == null) {
                    throw new IllegalStateException("Unexpected live owner");
                }
                new CodexMaintenanceJournal(coordination).requireSessionAvailable(new CodexStoragePaths(root), "remove");
                System.out.println("ADMITTED");
            } catch (java.io.IOException error) {
                System.out.println(error.getMessage());
            }
            return;
        }
        String boundary = arguments[3];
        int occurrence = Integer.parseInt(arguments[4]);
        AtomicInteger seen = new AtomicInteger();
        var service = new CodexStorageMaintenance(new CodexStoragePaths(root),
                new AiDataProcessGate(new AiDataMigrationCoordinator(coordination)), coordination,
                path -> Long.MAX_VALUE, true, checkpoint -> {
                    if (checkpoint.equals(boundary) && seen.incrementAndGet() == occurrence) {
                        Runtime.getRuntime().halt(77);
                    }
                });
        if (arguments[1].equals("delete")) {
            service.deleteSessions(List.of("remove"), arguments[2], false);
        } else {
            service.compact(service.databaseStatus().get("databaseId").getAsString(), arguments[2]);
        }
        throw new IllegalStateException("Requested crash boundary was not reached");
    }
}
