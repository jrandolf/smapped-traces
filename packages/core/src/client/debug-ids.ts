/**
 * Utilities for extracting debug IDs from the global scope.
 *
 * Debug IDs are stored by bundlers in one of two global variables:
 * - `globalThis._debugIds` (Turbopack): maps stack trace patterns to debug ID UUIDs
 * - `globalThis.__DEBUG_IDS__` (TC39 spec / webpack): maps resource URLs to debug ID UUIDs
 *
 * This module checks both locations and merges the results.
 */

import { parse as parseStackTrace } from "stacktrace-parser";

/**
 * Maps stack trace patterns to debug ID UUIDs.
 * Used by Turbopack (`_debugIds`).
 */
type StackTraceDebugIdMapping = Record<string, string>;

/**
 * Maps resource URLs directly to debug ID UUIDs.
 * Used by the TC39 spec (`__DEBUG_IDS__`).
 */
type UrlDebugIdMapping = Record<string, string>;

interface DebugIdGlobals {
  __DEBUG_IDS__?: UrlDebugIdMapping;
  _debugIds?: StackTraceDebugIdMapping;
}

function getGlobals(): DebugIdGlobals {
  return globalThis as unknown as DebugIdGlobals;
}

/**
 * Extracts file paths from a stack trace using stacktrace-parser.
 */
function extractFilesFromStack(stackTrace: string): string[] {
  return parseStackTrace(stackTrace)
    .map((frame) => frame.file)
    .filter((file): file is string => file !== null);
}

// Cache for parsed debug IDs by URL
let cachedDebugIdsByUrl: Map<string, string> | null = null;
let cachedEntryCount = 0;

/**
 * Resets the internal cache. Used for testing.
 * @internal
 */
export function resetDebugIdCache(): void {
  cachedDebugIdsByUrl = null;
  cachedEntryCount = 0;
}

/**
 * Counts total entries across both globals for cache invalidation.
 */
function countEntries(globals: DebugIdGlobals): number {
  let count = 0;
  if (globals._debugIds) {
    count += Object.keys(globals._debugIds).length;
  }
  if (globals.__DEBUG_IDS__) {
    count += Object.keys(globals.__DEBUG_IDS__).length;
  }
  return count;
}

/**
 * Builds a map from chunk URL to debug ID by reading both global sources:
 *
 * 1. `_debugIds` (Turbopack): keys are stack trace patterns like
 *    "Error\n    at http://localhost:3000/_next/static/chunks/page.js:1:172\n    at ..."
 *    We parse the stack to extract the URL.
 *
 * 2. `__DEBUG_IDS__` (TC39 spec / webpack): keys are resource URLs directly.
 *
 * Results are cached and invalidated when new debug IDs are registered.
 */
export function getDebugIdsByUrl(): Map<string, string> {
  const globals = getGlobals();

  if (!(globals._debugIds || globals.__DEBUG_IDS__)) {
    return new Map();
  }

  const currentCount = countEntries(globals);
  if (cachedDebugIdsByUrl && cachedEntryCount === currentCount) {
    return cachedDebugIdsByUrl;
  }

  const result = new Map<string, string>();

  // _debugIds: stack trace keys → parse to extract URL
  if (globals._debugIds) {
    for (const [stackPattern, debugId] of Object.entries(globals._debugIds)) {
      const urls = extractFilesFromStack(stackPattern);
      const url = urls[0];
      if (url && !result.has(url)) {
        result.set(url, debugId);
      }
    }
  }

  // __DEBUG_IDS__: URL keys → use directly
  if (globals.__DEBUG_IDS__) {
    for (const [url, debugId] of Object.entries(globals.__DEBUG_IDS__)) {
      if (!result.has(url)) {
        result.set(url, debugId);
      }
    }
  }

  cachedDebugIdsByUrl = result;
  cachedEntryCount = currentCount;

  return result;
}

/**
 * Extracts unique debug IDs referenced in a stack trace.
 *
 * @param stackTrace The exception stack trace string
 * @returns Array of unique debug ID UUIDs
 */
export function extractDebugIdsFromStack(stackTrace: string): string[] {
  const debugIdsByUrl = getDebugIdsByUrl();
  if (debugIdsByUrl.size === 0) {
    return [];
  }

  const debugIds = new Set<string>();

  for (const file of extractFilesFromStack(stackTrace)) {
    const debugId = debugIdsByUrl.get(file);
    if (debugId) {
      debugIds.add(debugId);
    }
  }

  return [...debugIds];
}
