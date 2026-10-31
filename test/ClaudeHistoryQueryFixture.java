import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;

/** Disposable subprocess transport for history failure and cancellation tests. */
public class ClaudeHistoryQueryFixture {
    public static void main(String[] args) throws Exception {
        if (args.length > 1) {
            Files.writeString(Path.of(args[1]), "READER_STARTED");
            System.in.read();
            return;
        }
        try {
            System.out.println(Files.readString(Path.of(args[0])));
        } catch (NoSuchFileException error) {
            System.out.println("{\"success\":false,\"missing\":true}");
        } catch (AccessDeniedException error) {
            System.out.println("{\"success\":false,\"error\":\"Permission denied reading history fixture\"}");
        }
    }
}
