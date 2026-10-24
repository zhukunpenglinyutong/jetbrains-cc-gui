package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;

/** Mutual domain-separated proofs. A stale/reused loopback port must not receive the endpoint secret. */
final class PetOfficeIpcAuthentication {
    private PetOfficeIpcAuthentication() { }

    static String proof(PetOfficeEndpointStore.Endpoint endpoint, String role, String instanceId, String epoch, String requestId) throws IOException {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(HexFormat.of().parseHex(endpoint.token()), "HmacSHA256"));
            String message = String.join("\n", "CCGUI-PET-OFFICE/" + PetOfficeEndpointStore.VERSION, role, endpoint.ownerInstanceId(), Integer.toString(endpoint.port()),
                    endpoint.leaderEpoch(), instanceId, epoch, requestId);
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException | IllegalArgumentException invalid) {
            throw new IOException("OFFICE_IPC_AUTH_UNAVAILABLE");
        }
    }

    static boolean verify(PetOfficeEndpointStore.Endpoint endpoint, String role, String instanceId, String epoch, String requestId,
                          JsonObject packet) throws IOException {
        String actual = PetOfficeIpcFrameCodec.string(packet, "authProof", 64);
        return actual.matches("[a-f0-9]{64}") && MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII),
                proof(endpoint, role, instanceId, epoch, requestId).getBytes(StandardCharsets.US_ASCII));
    }
}
