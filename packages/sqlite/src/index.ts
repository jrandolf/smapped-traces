import Database from "better-sqlite3";
import type { SourceMapStore } from "smapped-traces/store";

/**
 * Creates a source map store backed by a local SQLite database.
 *
 * The database and table are created on first write. Reads against a
 * non-existent database return null.
 */
export function createSqliteStore(dbPath: string): SourceMapStore {
  let db: Database.Database | null = null;
  let tableCreated = false;

  function ensureDb(): Database.Database {
    if (!db) {
      db = new Database(dbPath);
    }
    return db;
  }

  function ensureTable(database: Database.Database): void {
    if (!tableCreated) {
      database.exec(
        "CREATE TABLE IF NOT EXISTS sourcemaps (debugId TEXT PRIMARY KEY, content BLOB)"
      );
      tableCreated = true;
    }
  }

  return {
    get(debugId: string) {
      try {
        const database = ensureDb();
        const row = database
          .prepare(
            "SELECT json(content) as content FROM sourcemaps WHERE debugId = ?"
          )
          .get(debugId) as { content: string } | undefined;
        return row?.content ?? null;
      } catch {
        return null;
      }
    },

    put(debugId: string, content: string) {
      const database = ensureDb();
      ensureTable(database);
      database
        .prepare(
          "INSERT OR REPLACE INTO sourcemaps (debugId, content) VALUES (?, jsonb(?))"
        )
        .run(debugId, content);
    },

    close() {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}
