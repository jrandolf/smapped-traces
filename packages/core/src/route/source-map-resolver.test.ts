import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceMapStore } from "../store/types.js";
import {
  createSourceMapResolver,
  formatStackTrace,
  type SourceMapResolver,
} from "./source-map-resolver.js";

const HANDLE_CLICK_PATTERN = /at handleClick \(src\/app\.ts:1:1\)/;

function createMemoryStore(): SourceMapStore & {
  insert(debugId: string, map: object): void;
} {
  const map = new Map<string, string>();
  return {
    insert(debugId, sourceMap) {
      map.set(debugId, JSON.stringify(sourceMap));
    },
    get(debugId) {
      return map.get(debugId) ?? null;
    },
    put(debugId, content) {
      map.set(debugId, content);
    },
  };
}

/**
 * Creates an index source map with sections.
 */
function createIndexSourceMap(
  sections: Array<{
    offset: { line: number; column: number };
    map: {
      sources: string[];
      names: string[];
      mappings: string;
    };
  }>
) {
  return {
    version: 3,
    sections: sections.map((section) => ({
      offset: section.offset,
      map: {
        version: 3,
        sources: section.map.sources,
        names: section.map.names,
        mappings: section.map.mappings,
        sourcesContent: section.map.sources.map(
          (s) => `// Source content for ${s}`
        ),
      },
    })),
  };
}

/**
 * Creates a simple source map (non-index).
 */
function createSimpleSourceMap(options: {
  sources: string[];
  names: string[];
  mappings: string;
}) {
  return {
    version: 3,
    sources: options.sources,
    names: options.names,
    mappings: options.mappings,
    sourcesContent: options.sources.map((s) => `// Source content for ${s}`),
  };
}

describe("source-map-resolver", () => {
  let store: ReturnType<typeof createMemoryStore>;
  let resolver: SourceMapResolver | null = null;

  beforeEach(() => {
    store = createMemoryStore();
  });

  afterEach(() => {
    resolver?.close();
    resolver = null;
  });

  describe("index source maps", () => {
    it("resolves a stack trace using an index map with a single section", async () => {
      const debugId = "test-debug-id-1";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: {
              sources: ["src/app.ts"],
              names: ["handleClick"],
              mappings: "AAAAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved).toContain("src/app.ts");
      expect(resolved).toMatch(HANDLE_CLICK_PATTERN);
    });

    it("correctly maps line and column numbers in index maps", async () => {
      const debugId = "test-debug-id-exact";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: {
              sources: ["src/original.ts"],
              names: ["myFunction"],
              mappings: "AAKAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Test
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved).toContain("src/original.ts:6:1");
      expect(resolved).toContain("myFunction");
    });

    it("resolves frames from different sections in an index map", async () => {
      const debugId = "test-debug-id-2";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: {
              sources: ["src/header.ts"],
              names: ["renderHeader"],
              mappings: "AAAA",
            },
          },
          {
            offset: { line: 100, column: 0 },
            map: {
              sources: ["src/footer.ts"],
              names: ["renderFooter"],
              mappings: "AAAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Footer error
    at http://localhost:3000/_next/static/chunks/app.js:101:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved).toContain("src/footer.ts");
    });

    it("handles index maps with multiple sources in a single section", async () => {
      const debugId = "test-debug-id-3";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: {
              sources: ["src/utils.ts", "src/helpers.ts"],
              names: ["utilFunc", "helperFunc"],
              mappings: "AAAA;ACAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Test error
    at http://localhost:3000/_next/static/chunks/app.js:2:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved).toContain("src/helpers.ts");
    });

    it("returns original stack trace when no source map is found", async () => {
      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: No source map
    at http://localhost:3000/_next/static/chunks/unknown.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [
        "non-existent-id",
      ]);

      expect(resolved).toBe(stackTrace);
    });

    it("handles empty debug IDs array", async () => {
      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: No debug IDs
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, []);

      expect(resolved).toBe(stackTrace);
    });

    it("caches source map consumers for repeated lookups", async () => {
      const debugId = "test-debug-id-cache";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: {
              sources: ["src/cached.ts"],
              names: ["cachedFunc"],
              mappings: "AAAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store, maxCacheSize: 10 });

      const stackTrace = `Error: Cache test
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved1 = await resolver.resolveStackTrace(stackTrace, [debugId]);
      const resolved2 = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved1).toBe(resolved2);
      expect(resolved1).toContain("src/cached.ts");
    });

    it("handles index maps with nested section offsets", async () => {
      const debugId = "test-debug-id-nested";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 0 },
            map: { sources: ["src/section1.ts"], names: [], mappings: "AAAA" },
          },
          {
            offset: { line: 50, column: 0 },
            map: { sources: ["src/section2.ts"], names: [], mappings: "AAAA" },
          },
          {
            offset: { line: 150, column: 0 },
            map: { sources: ["src/section3.ts"], names: [], mappings: "AAAA" },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stack1 =
        "Error: Section 1\n    at http://localhost:3000/_next/static/chunks/app.js:1:1";
      expect(await resolver.resolveStackTrace(stack1, [debugId])).toContain(
        "src/section1.ts"
      );

      const stack2 =
        "Error: Section 2\n    at http://localhost:3000/_next/static/chunks/app.js:51:1";
      expect(await resolver.resolveStackTrace(stack2, [debugId])).toContain(
        "src/section2.ts"
      );

      const stack3 =
        "Error: Section 3\n    at http://localhost:3000/_next/static/chunks/app.js:151:1";
      expect(await resolver.resolveStackTrace(stack3, [debugId])).toContain(
        "src/section3.ts"
      );
    });

    it("handles column offsets in index map sections", async () => {
      const debugId = "test-debug-id-col-offset";

      store.insert(
        debugId,
        createIndexSourceMap([
          {
            offset: { line: 0, column: 100 },
            map: {
              sources: ["src/inline.ts"],
              names: ["inlineFunc"],
              mappings: "AAAA",
            },
          },
        ])
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Column offset test
    at http://localhost:3000/_next/static/chunks/app.js:1:101`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [debugId]);

      expect(resolved).toContain("src/inline.ts");
    });
  });

  describe("formatStackTrace", () => {
    it("preserves error message when formatting resolved frames", () => {
      const original = `TypeError: Cannot read property 'foo' of undefined
    at someFunction (app.js:10:20)
    at anotherFunction (app.js:15:30)`;

      const frames = [
        {
          methodName: "someFunction",
          file: "app.js",
          lineNumber: 10,
          column: 20,
          arguments: [],
        },
        {
          methodName: "anotherFunction",
          file: "app.js",
          lineNumber: 15,
          column: 30,
          arguments: [],
        },
      ];

      const resolved = new Map([
        [
          0,
          {
            methodName: "originalFunction",
            file: "src/original.ts",
            lineNumber: 5,
            column: 10,
            arguments: [],
          },
        ],
      ]);

      const formatted = formatStackTrace(original, frames, resolved);

      expect(formatted).toContain(
        "TypeError: Cannot read property 'foo' of undefined"
      );
      expect(formatted).toContain("src/original.ts");
      expect(formatted).toContain("originalFunction");
    });

    it("handles frames without method names", () => {
      const original = `Error: test
    at app.js:1:1`;

      const frames = [
        {
          methodName: "<unknown>",
          file: "app.js",
          lineNumber: 1,
          column: 1,
          arguments: [],
        },
      ];

      const resolved = new Map([
        [
          0,
          {
            methodName: "<unknown>",
            file: "src/file.ts",
            lineNumber: 10,
            column: 5,
            arguments: [],
          },
        ],
      ]);

      const formatted = formatStackTrace(original, frames, resolved);

      expect(formatted).toContain("src/file.ts:10:5");
    });
  });

  describe("multiple debug IDs", () => {
    it("loads multiple source maps and attempts resolution with each", async () => {
      const debugId1 = "debug-id-chunk-1";
      const debugId2 = "debug-id-chunk-2";

      store.insert(
        debugId1,
        createSimpleSourceMap({
          sources: ["src/chunk1.ts"],
          names: ["chunk1Func"],
          mappings: "AAAA",
        })
      );
      store.insert(
        debugId2,
        createSimpleSourceMap({
          sources: ["src/chunk2.ts"],
          names: ["chunk2Func"],
          mappings: "AAgGA",
        })
      );

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Multi-chunk error
    at http://localhost:3000/_next/static/chunks/chunk1.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [
        debugId1,
        debugId2,
      ]);

      expect(resolved).toContain("src/chunk1.ts");
    });
  });

  describe("LRU cache eviction", () => {
    it("evicts oldest entries when cache is full", async () => {
      resolver = createSourceMapResolver({ store, maxCacheSize: 2 });

      for (let i = 1; i <= 3; i++) {
        store.insert(
          `debug-id-${i}`,
          createSimpleSourceMap({
            sources: [`src/file${i}.ts`],
            names: [],
            mappings: "AAAA",
          })
        );
      }

      const stackTrace = `Error: Cache eviction test
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      await resolver.resolveStackTrace(stackTrace, ["debug-id-1"]);
      await resolver.resolveStackTrace(stackTrace, ["debug-id-2"]);
      await resolver.resolveStackTrace(stackTrace, ["debug-id-3"]);

      const resolved = await resolver.resolveStackTrace(stackTrace, [
        "debug-id-1",
      ]);

      expect(resolved).toContain("src/file1.ts");
    });
  });

  describe("error handling", () => {
    it("handles invalid source map JSON gracefully", async () => {
      store.insert("invalid-map", { invalid: true });

      resolver = createSourceMapResolver({ store });

      const stackTrace = `Error: Invalid map test
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [
        "invalid-map",
      ]);

      expect(resolved).toBe(stackTrace);
    });

    it("handles store read errors gracefully", async () => {
      const errorStore: SourceMapStore = {
        get() {
          throw new Error("read error");
        },
        put() {
          /* noop */
        },
      };
      resolver = createSourceMapResolver({ store: errorStore });

      const stackTrace = `Error: DB error test
    at http://localhost:3000/_next/static/chunks/app.js:1:1`;

      const resolved = await resolver.resolveStackTrace(stackTrace, [
        "some-id",
      ]);

      expect(resolved).toBe(stackTrace);
    });
  });
});
