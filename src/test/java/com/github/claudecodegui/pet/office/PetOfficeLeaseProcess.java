package com.github.claudecodegui.pet.office;

import java.nio.file.Path;

/** Controlled JVM fixture; never connects to an IDE or an AI provider. */
public final class PetOfficeLeaseProcess {
    public static void main(String[] args) throws Exception {
        PetOfficeRuntimeLease lease = PetOfficeRuntimeLease.tryAcquire(Path.of(args[0])).orElse(null);
        System.out.println(lease == null ? "BUSY" : "ACQUIRED");
        System.out.flush();
        if (lease != null) {
            try (lease) {
                if ("hold".equals(args[1])) {
                    System.in.read();
                }
            }
        }
    }
}
