/**
 * Source map resolution for stack traces.
 *
 * This module provides utilities to resolve minified JavaScript stack traces
 * back to their original source locations using a {@link SourceMapStore}.
 */

import {
  type RawIndexMap,
  type RawSourceMap,
  SourceMapConsumer,
} from "source-map";
import { parse as parseStackTrace, type StackFrame } from "stacktrace-parser";
import type { SourceMapStore } from "../store/types.js";

/**
 * Options for creating a source map resolver.
 */
export interface SourceMapResolverOptions {
  /** Maximum number of source map consumers to cache. */
  maxCacheSize?: number;
  /** Source map storage backend. */
  store: SourceMapStore;
}

/**
 * Formats a single frame in V8 style.
 */
function formatFrame(frame: StackFrame): string {
  const funcPart = frame.methodName
    ? `${frame.methodName} (${frame.file}:${frame.lineNumber}:${frame.column})`
    : `${frame.file}:${frame.lineNumber}:${frame.column}`;
  return `    at ${funcPart}`;
}

/**
 * Formats resolved frames back into a stack trace string.
 * Extracts the error message from the original trace and appends resolved frames.
 */
export function formatStackTrace(
  originalTrace: string,
  originalFrames: StackFrame[],
  resolvedFrames: Map<number, StackFrame>
): string {
  const lines = originalTrace.split("\n");
  const result: string[] = [];

  let frameStartIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("at ") || line.includes("@")) {
      frameStartIndex = i;
      break;
    }
    result.push(line);
  }

  for (let i = 0; i < originalFrames.length; i++) {
    const resolved = resolvedFrames.get(i);
    if (resolved) {
      result.push(formatFrame(resolved));
    } else {
      const originalLine = lines[frameStartIndex + i];
      if (originalLine !== undefined) {
        result.push(originalLine);
      } else {
        result.push(formatFrame(originalFrames[i]));
      }
    }
  }

  return result.join("\n");
}

/**
 * LRU cache for SourceMapConsumer instances.
 */
class SourceMapCache {
  readonly #maxSize: number;
  readonly #cache = new Map<string, SourceMapConsumer>();
  readonly #order: string[] = [];

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  get(debugId: string): SourceMapConsumer | undefined {
    const consumer = this.#cache.get(debugId);
    if (consumer) {
      const idx = this.#order.indexOf(debugId);
      if (idx !== -1) {
        this.#order.splice(idx, 1);
        this.#order.push(debugId);
      }
    }
    return consumer;
  }

  set(debugId: string, consumer: SourceMapConsumer): void {
    if (this.#cache.has(debugId)) {
      return;
    }

    while (this.#order.length >= this.#maxSize) {
      const oldest = this.#order.shift();
      if (oldest) {
        const oldConsumer = this.#cache.get(oldest);
        if (oldConsumer) {
          oldConsumer.destroy();
        }
        this.#cache.delete(oldest);
      }
    }

    this.#cache.set(debugId, consumer);
    this.#order.push(debugId);
  }

  clear(): void {
    for (const consumer of this.#cache.values()) {
      consumer.destroy();
    }
    this.#cache.clear();
    this.#order.length = 0;
  }
}

/**
 * Source map resolver that uses a {@link SourceMapStore} for storage.
 */
export interface SourceMapResolver {
  close(): void;
  resolveStackTrace(stackTrace: string, debugIds: string[]): Promise<string>;
}

/**
 * Creates a source map resolver instance.
 */
export function createSourceMapResolver(
  options: SourceMapResolverOptions
): SourceMapResolver {
  const { store, maxCacheSize = 50 } = options;
  const cache = new SourceMapCache(maxCacheSize);

  async function loadSourceMaps(
    debugIds: string[]
  ): Promise<Map<string, SourceMapConsumer>> {
    const result = new Map<string, SourceMapConsumer>();
    const uncachedIds: string[] = [];

    for (const debugId of debugIds) {
      const cached = cache.get(debugId);
      if (cached) {
        result.set(debugId, cached);
      } else {
        uncachedIds.push(debugId);
      }
    }

    if (uncachedIds.length === 0) {
      return result;
    }

    await Promise.all(
      uncachedIds.map(async (debugId) => {
        try {
          const content = await store.get(debugId);
          if (!content) {
            return;
          }
          const rawSourceMap = JSON.parse(content) as
            | RawSourceMap
            | RawIndexMap;
          const consumer = await new SourceMapConsumer(rawSourceMap);
          cache.set(debugId, consumer);
          result.set(debugId, consumer);
        } catch {
          // Skip invalid source maps
        }
      })
    );

    return result;
  }

  function tryResolveWithConsumer(
    consumer: SourceMapConsumer,
    lineNumber: number,
    columnNumber: number,
    methodName: string | null
  ): StackFrame | null {
    try {
      const original = consumer.originalPositionFor({
        line: lineNumber,
        column: columnNumber - 1,
      });

      if (original.source) {
        return {
          methodName: original.name || methodName || "<unknown>",
          file: original.source,
          lineNumber: original.line ?? lineNumber,
          column: (original.column ?? columnNumber - 1) + 1,
          arguments: [],
        };
      }
    } catch {
      // Source map lookup failed
    }
    return null;
  }

  function resolveFrame(
    frame: StackFrame,
    consumers: Map<string, SourceMapConsumer>
  ): StackFrame | null {
    const lineNumber = frame.lineNumber ?? 0;
    const columnNumber = frame.column ?? 0;

    for (const consumer of consumers.values()) {
      const resolved = tryResolveWithConsumer(
        consumer,
        lineNumber,
        columnNumber,
        frame.methodName || null
      );
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  async function resolveStackTrace(
    stackTrace: string,
    debugIds: string[]
  ): Promise<string> {
    if (debugIds.length === 0) {
      return stackTrace;
    }

    const consumers = await loadSourceMaps(debugIds);
    if (consumers.size === 0) {
      return stackTrace;
    }

    const frames = parseStackTrace(stackTrace);
    const resolvedFrames = new Map<number, StackFrame>();

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const resolved = resolveFrame(frame, consumers);
      if (resolved) {
        resolvedFrames.set(i, resolved);
      }
    }

    return formatStackTrace(stackTrace, frames, resolvedFrames);
  }

  function close(): void {
    cache.clear();
    store.close?.();
  }

  return {
    resolveStackTrace,
    close,
  };
}
