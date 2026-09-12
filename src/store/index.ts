/** Store selection: PostgreSQL when configured, the file store otherwise. */

import { FileStore } from './file-store';
import { PostgresStore } from './postgres-store';
import type { Store } from './types';

export * from './types';
export { FileStore } from './file-store';
export { PostgresStore } from './postgres-store';

let instance: Store | null = null;

/**
 * The process-wide store.
 *
 * Setting `DATABASE_URL` selects PostgreSQL; leaving it unset falls back to
 * JSON files under `DATA_DIR` (default `.data`), so the app runs with no
 * database installed.
 */
export function getStore(): Store {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    instance = connectionString
      ? new PostgresStore(connectionString)
      : new FileStore(process.env.DATA_DIR ?? '.data');
  }
  return instance;
}

/** Test hook: drop the memoised store so the next call re-reads the env. */
export function resetStore(): void {
  instance = null;
}
