import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractDebugIdsFromStack,
  getDebugIdsByUrl,
  resetDebugIdCache,
} from "./debug-ids.js";

interface DebugIdGlobals {
  __DEBUG_IDS__?: Record<string, string>;
  _debugIds?: Record<string, string>;
}

function g(): DebugIdGlobals {
  return globalThis as unknown as DebugIdGlobals;
}

describe("debug-ids", () => {
  const originalDebugIds = g()._debugIds;
  const originalDebugIdsSpec = g().__DEBUG_IDS__;

  beforeEach(() => {
    g()._debugIds = undefined;
    g().__DEBUG_IDS__ = undefined;
    resetDebugIdCache();
  });

  afterEach(() => {
    g()._debugIds = originalDebugIds;
    g().__DEBUG_IDS__ = originalDebugIdsSpec;
    resetDebugIdCache();
  });

  describe("getDebugIdsByUrl", () => {
    it("returns an empty map when neither global is defined", () => {
      const result = getDebugIdsByUrl();
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("extracts URLs from stack patterns in _debugIds", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172\n    at Object.<anonymous>":
          debugId,
      };

      const result = getDebugIdsByUrl();
      expect(result.size).toBe(1);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/page.js")
      ).toBe(debugId);
    });

    it("reads URL keys directly from __DEBUG_IDS__", () => {
      const debugId = "660e8400-e29b-41d4-a716-446655440000";
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/app.js": debugId,
      };

      const result = getDebugIdsByUrl();
      expect(result.size).toBe(1);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/app.js")
      ).toBe(debugId);
    });

    it("merges entries from both globals", () => {
      const debugId1 = "550e8400-e29b-41d4-a716-446655440001";
      const debugId2 = "660e8400-e29b-41d4-a716-446655440002";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId1,
      };
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/vendor.js": debugId2,
      };

      const result = getDebugIdsByUrl();
      expect(result.size).toBe(2);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/page.js")
      ).toBe(debugId1);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/vendor.js")
      ).toBe(debugId2);
    });

    it("_debugIds takes precedence over __DEBUG_IDS__ for the same URL", () => {
      const turbopackId = "550e8400-e29b-41d4-a716-446655440001";
      const specId = "660e8400-e29b-41d4-a716-446655440002";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          turbopackId,
      };
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/page.js": specId,
      };

      const result = getDebugIdsByUrl();
      expect(result.size).toBe(1);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/page.js")
      ).toBe(turbopackId);
    });

    it("handles multiple debug ID mappings", () => {
      const debugId1 = "550e8400-e29b-41d4-a716-446655440001";
      const debugId2 = "550e8400-e29b-41d4-a716-446655440002";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId1,
        "Error\n    at http://localhost:3000/_next/static/chunks/main.js:5:42":
          debugId2,
      };

      const result = getDebugIdsByUrl();
      expect(result.size).toBe(2);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/page.js")
      ).toBe(debugId1);
      expect(
        result.get("http://localhost:3000/_next/static/chunks/main.js")
      ).toBe(debugId2);
    });

    it("caches results and returns same map for subsequent calls", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId,
      };

      const result1 = getDebugIdsByUrl();
      const result2 = getDebugIdsByUrl();

      expect(result1).toBe(result2);
    });

    it("invalidates cache when new _debugIds entries are added", () => {
      const debugId1 = "550e8400-e29b-41d4-a716-446655440001";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId1,
      };

      const result1 = getDebugIdsByUrl();
      expect(result1.size).toBe(1);

      const debugId2 = "550e8400-e29b-41d4-a716-446655440002";
      g()._debugIds![
        "Error\n    at http://localhost:3000/_next/static/chunks/main.js:5:42"
      ] = debugId2;

      const result2 = getDebugIdsByUrl();
      expect(result2.size).toBe(2);
      expect(result1).not.toBe(result2);
    });

    it("invalidates cache when new __DEBUG_IDS__ entries are added", () => {
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/page.js":
          "550e8400-e29b-41d4-a716-446655440001",
      };

      const result1 = getDebugIdsByUrl();
      expect(result1.size).toBe(1);

      g().__DEBUG_IDS__!["http://localhost:3000/_next/static/chunks/main.js"] =
        "550e8400-e29b-41d4-a716-446655440002";

      const result2 = getDebugIdsByUrl();
      expect(result2.size).toBe(2);
      expect(result1).not.toBe(result2);
    });

    it("handles complex stack traces with multiple URLs per pattern", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172\n    at http://localhost:3000/_next/static/chunks/other.js:10:5":
          debugId,
      };

      const result = getDebugIdsByUrl();
      // Only the first URL from each pattern should be mapped
      expect(
        result.get("http://localhost:3000/_next/static/chunks/page.js")
      ).toBe(debugId);
    });
  });

  describe("extractDebugIdsFromStack", () => {
    it("returns an empty array when neither global is defined", () => {
      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/page.js:1:172`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toEqual([]);
    });

    it("extracts debug IDs from _debugIds", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/page.js:1:172
    at someFunction (http://localhost:3000/_next/static/chunks/page.js:50:10)`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toContain(debugId);
    });

    it("extracts debug IDs from __DEBUG_IDS__", () => {
      const debugId = "660e8400-e29b-41d4-a716-446655440000";
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/app.js": debugId,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/app.js:1:172`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toContain(debugId);
    });

    it("extracts debug IDs from both globals in one stack trace", () => {
      const debugId1 = "550e8400-e29b-41d4-a716-446655440001";
      const debugId2 = "660e8400-e29b-41d4-a716-446655440002";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId1,
      };
      g().__DEBUG_IDS__ = {
        "http://localhost:3000/_next/static/chunks/vendor.js": debugId2,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/page.js:1:172
    at http://localhost:3000/_next/static/chunks/vendor.js:5:42`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toHaveLength(2);
      expect(result).toContain(debugId1);
      expect(result).toContain(debugId2);
    });

    it("returns unique debug IDs only", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/page.js:1:172
    at anotherFunction (http://localhost:3000/_next/static/chunks/page.js:100:20)
    at yetAnotherFunction (http://localhost:3000/_next/static/chunks/page.js:200:30)`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(debugId);
    });

    it("returns multiple debug IDs when different files are in stack", () => {
      const debugId1 = "550e8400-e29b-41d4-a716-446655440001";
      const debugId2 = "550e8400-e29b-41d4-a716-446655440002";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId1,
        "Error\n    at http://localhost:3000/_next/static/chunks/main.js:5:42":
          debugId2,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/page.js:1:172
    at http://localhost:3000/_next/static/chunks/main.js:5:42`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toHaveLength(2);
      expect(result).toContain(debugId1);
      expect(result).toContain(debugId2);
    });

    it("ignores files not in the debug ID mapping", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172":
          debugId,
      };

      const stackTrace = `Error: Something went wrong
    at http://localhost:3000/_next/static/chunks/unknown.js:1:172`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toEqual([]);
    });

    it("handles V8 style stack traces", () => {
      const debugId = "550e8400-e29b-41d4-a716-446655440000";
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/app.js:10:20":
          debugId,
      };

      const stackTrace = `TypeError: Cannot read property 'foo' of undefined
    at Object.handleClick (http://localhost:3000/_next/static/chunks/app.js:10:20)
    at HTMLButtonElement.callCallback (http://localhost:3000/_next/static/chunks/react.js:1:1)`;

      const result = extractDebugIdsFromStack(stackTrace);
      expect(result).toContain(debugId);
    });

    it("handles empty stack traces", () => {
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/app.js:10:20":
          "550e8400-e29b-41d4-a716-446655440000",
      };

      const result = extractDebugIdsFromStack("");
      expect(result).toEqual([]);
    });

    it("handles stack traces with no file references", () => {
      g()._debugIds = {
        "Error\n    at http://localhost:3000/_next/static/chunks/app.js:10:20":
          "550e8400-e29b-41d4-a716-446655440000",
      };

      const result = extractDebugIdsFromStack("Error: Something went wrong");
      expect(result).toEqual([]);
    });
  });
});
