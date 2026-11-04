import { stat } from 'node:fs/promises';

/** Native thread/list can retain database rows after their rollout was deleted on disk. */
export async function filterAvailableCodexThreads(threads, { statFile = stat } = {}) {
  const available = [];
  for (let offset = 0; offset < threads.length; offset += 32) {
    const batch = threads.slice(offset, offset + 32);
    const exists = await Promise.all(batch.map(async thread => {
      // Ephemeral threads and older servers without a path have no file to check.
      if (thread?.ephemeral === true || typeof thread?.path !== 'string' || !thread.path) return true;
      try {
        await statFile(thread.path);
        return true;
      } catch (error) {
        // Permission or temporary I/O failures do not prove the session was removed.
        return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
      }
    }));
    available.push(...batch.filter((_, index) => exists[index]));
  }
  return available;
}
