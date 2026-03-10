import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceMapStore } from "smapped-traces/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteStore } from "./index.js";

describe("SQLite Store", () => {
  let tmpDir: string;
  let store: SourceMapStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "store-test-"));
    store = createSqliteStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("put then get returns the same content", async () => {
    const content = JSON.stringify({
      version: 3,
      sources: ["index.ts"],
      mappings: "AAAA",
    });
    await store.put("debug-id-1", content);
    const result = await store.get("debug-id-1");
    expect(JSON.parse(result!)).toEqual(JSON.parse(content));
  });

  it("get for non-existent debugId returns null", async () => {
    await store.put("existing", '{"version":3}');
    const result = await store.get("does-not-exist");
    expect(result).toBeNull();
  });

  it("get from non-existent DB path returns null", async () => {
    const badStore = createSqliteStore(
      join(tmpDir, "nonexistent", "deep", "test.db")
    );
    const result = await badStore.get("anything");
    expect(result).toBeNull();
  });

  it("put overwrites existing entry", async () => {
    const original = JSON.stringify({ version: 3, mappings: "AAAA" });
    const updated = JSON.stringify({ version: 3, mappings: "BBBB" });

    await store.put("overwrite-id", original);
    await store.put("overwrite-id", updated);

    const result = await store.get("overwrite-id");
    expect(JSON.parse(result!)).toEqual(JSON.parse(updated));
  });

  it("close() releases resources, subsequent close is safe", () => {
    store.close?.();
    expect(() => store.close?.()).not.toThrow();
  });

  it("handles special characters in debugId", async () => {
    const ids = [
      "550e8400-e29b-41d4-a716-446655440000",
      "file.name.with.dots",
      "mixed-dots.and-hyphens-123",
    ];
    for (const id of ids) {
      const content = JSON.stringify({ id });
      await store.put(id, content);
      const result = await store.get(id);
      expect(JSON.parse(result!)).toEqual(JSON.parse(content));
    }
  });

  it("handles large source map content", async () => {
    const largeContent = JSON.stringify({
      version: 3,
      sources: Array.from({ length: 1000 }, (_, i) => `src/file${i}.ts`),
      mappings: "A".repeat(100_000),
    });

    await store.put("large-id", largeContent);
    const result = await store.get("large-id");
    expect(JSON.parse(result!)).toEqual(JSON.parse(largeContent));
  });

  it("table is created lazily on first put", async () => {
    const freshStore = createSqliteStore(join(tmpDir, "lazy.db"));
    try {
      const result = await freshStore.get("anything");
      expect(result).toBeNull();

      await freshStore.put("id-1", '{"version":3}');
      const result2 = await freshStore.get("id-1");
      expect(result2).not.toBeNull();
    } finally {
      freshStore.close?.();
    }
  });
});
