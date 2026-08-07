import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SourceMapStore } from "smapped-traces/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSourceMaps, sourceMaps } from "./index.js";

describe("sourceMaps plugin", () => {
  it("applies to builds only", () => {
    expect(sourceMaps().apply).toBe("build");
  });

  it("configures hidden source maps with debug IDs", () => {
    const plugin = sourceMaps();
    expect(typeof plugin.config).toBe("function");
    const config = (
      plugin.config as (
        config: unknown,
        env: { command: string; mode: string }
      ) => unknown
    )({}, { command: "build", mode: "production" });
    expect(config).toEqual({
      build: {
        sourcemap: "hidden",
        rolldownOptions: {
          output: {
            sourcemapDebugIds: true,
          },
        },
      },
    });
  });
});

describe("collectSourceMaps", () => {
  let tmpDir: string;
  let entries: Map<string, string>;
  let closed: number;
  let store: SourceMapStore;

  const writeMap = async (relative: string, map: object): Promise<void> => {
    const path = join(tmpDir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(map));
  };

  const remainingFiles = async (): Promise<string[]> => {
    const files = await readdir(tmpDir, { recursive: true });
    return files.filter((file) => file.endsWith(".map")).sort();
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "collect-test-"));
    entries = new Map();
    closed = 0;
    store = {
      close: () => {
        closed += 1;
      },
      get: (debugId) => entries.get(debugId) ?? null,
      put: (debugId, content) => {
        entries.set(debugId, content);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores debug-ID-keyed maps and deletes every map file", async () => {
    await writeMap("client/entry.js.map", { debugId: "id-js", version: 3 });
    await writeMap("client/chunk.mjs.map", { debugId: "id-mjs", version: 3 });
    await writeMap("client/legacy.cjs.map", { debugId: "id-cjs", version: 3 });
    await writeMap("client/style.css.map", { version: 3 });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => store,
    });

    expect(result).toEqual({ deleted: 4, stored: 3 });
    expect([...entries.keys()].sort()).toEqual(["id-cjs", "id-js", "id-mjs"]);
    expect(JSON.parse(entries.get("id-js") ?? "")).toEqual({
      debugId: "id-js",
      version: 3,
    });
    expect(await remainingFiles()).toEqual([]);
    expect(closed).toBe(1);
  });

  it("restricts storage to included maps while deleting the rest", async () => {
    await writeMap("client/entry.js.map", { debugId: "client-id" });
    await writeMap("server/index.js.map", { version: 3 });

    const result = await collectSourceMaps({
      dir: tmpDir,
      include: "client/**/*.{,c,m}js.map",
      store: () => store,
    });

    expect(result).toEqual({ deleted: 2, stored: 1 });
    expect([...entries.keys()]).toEqual(["client-id"]);
    expect(await remainingFiles()).toEqual([]);
  });

  it("sweeps dot directories", async () => {
    await writeMap("client/.well-known/entry.js.map", { debugId: "dot-id" });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => store,
    });

    expect(result).toEqual({ deleted: 1, stored: 1 });
    expect([...entries.keys()]).toEqual(["dot-id"]);
    expect(await remainingFiles()).toEqual([]);
  });

  it("rejects included maps without a debug ID after sweeping", async () => {
    await writeMap("client/entry.js.map", { debugId: "good-id" });
    await writeMap("client/broken.js.map", { version: 3 });
    await writeMap("client/empty.js.map", { debugId: "" });

    await expect(
      collectSourceMaps({
        dir: tmpDir,
        store: () => store,
      })
    ).rejects.toThrow(
      "source maps missing debugId (sourceMaps plugin not applied?):\n  client/broken.js.map\n  client/empty.js.map"
    );

    expect([...entries.keys()]).toEqual(["good-id"]);
    expect(await remainingFiles()).toEqual([]);
    expect(closed).toBe(1);
  });

  it("closes the store when reading a map fails", async () => {
    await writeMap("client/entry.js.map", { debugId: "id" });
    await writeFile(join(tmpDir, "client/invalid.js.map"), "not json");

    await expect(
      collectSourceMaps({
        dir: tmpDir,
        store: () => store,
      })
    ).rejects.toThrow(SyntaxError);

    expect(closed).toBe(1);
  });

  it("supports asynchronous store factories", async () => {
    await writeMap("entry.js.map", { debugId: "async-id" });

    const result = await collectSourceMaps({
      dir: tmpDir,
      store: () => Promise.resolve(store),
    });

    expect(result).toEqual({ deleted: 1, stored: 1 });
    expect([...entries.keys()]).toEqual(["async-id"]);
  });
});
