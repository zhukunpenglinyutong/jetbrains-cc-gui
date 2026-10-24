import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

public class AiDataMigrationLockHolder {
    public static void main(String[] args) throws Exception {
        try (FileChannel channel = FileChannel.open(Path.of(args[0]), StandardOpenOption.CREATE,
                StandardOpenOption.READ, StandardOpenOption.WRITE);
             FileLock ignored = channel.lock(0L, Long.MAX_VALUE, args.length > 1 && "shared".equals(args[1]))) {
            System.out.println("LOCKED");
            System.out.flush();
            System.in.read();
        }
    }
}
