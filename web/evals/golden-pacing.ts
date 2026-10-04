import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Coordinates local Phase 1 jobs; waiting never retries a provider request. */
export async function acquireGoldenLock(directory: string, name = 'live.lock') {
  const path = join(directory, name);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      return async () => {
        await handle.close();
        await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error('Phase 1 lock remains held; inspect the previous job.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function paceGoldenVoyage(directory: string) {
  const release = await acquireGoldenLock(directory, 'voyage-pacing.lock');
  try {
    const path = join(directory, 'voyage-pacing.json');
    let previous = 0;
    try {
      previous = (JSON.parse(await readFile(path, 'utf8')) as { at: number })
        .at;
      if (!Number.isSafeInteger(previous) || previous < 0)
        throw new Error('Invalid Phase 1 Voyage pacing state.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const delay = previous + 21_000 - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const handle = await open(path, 'w', 0o600);
    try {
      await handle.write(JSON.stringify({ at: Date.now() }) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    await release();
  }
}
