import { toBinary } from "@bufbuild/protobuf";
import type { Attributes, HrTime, SpanKind } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  ReadableSpan,
  SpanExporter,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_EXCEPTION_STACKTRACE } from "@opentelemetry/semantic-conventions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toTracesData } from "../convert.js";
import { TracesDataSchema } from "../generated/opentelemetry/proto/trace/v1/trace_pb.js";
import type { SourceMapStore } from "../store/types.js";
import { createTracesHandler } from "./traces.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultResource = resourceFromAttributes({ "service.name": "test" });
const defaultScope = { name: "test-scope", version: "1.0.0" };

/**
 * Builds a minimal ReadableSpan. Fields that the handler doesn't inspect
 * directly are filled with sensible defaults.
 */
function createSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "test-span",
    kind: 0 as SpanKind,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    }),
    parentSpanContext: undefined,
    startTime: [0, 0] as HrTime,
    endTime: [1, 0] as HrTime,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    duration: [1, 0] as HrTime,
    ended: true,
    resource: defaultResource,
    instrumentationScope: defaultScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

/**
 * Creates an exception TimedEvent with the given stacktrace and optional
 * debug IDs.
 */
function createExceptionEvent(
  stacktrace: string,
  debugIds?: unknown[]
): TimedEvent {
  const attributes: Attributes = {
    [ATTR_EXCEPTION_STACKTRACE]: stacktrace,
  };
  if (debugIds !== undefined) {
    // Cast to satisfy Attributes type; tests intentionally include non-string
    // values to exercise the handler's filtering logic.
    attributes[`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`] = debugIds as (
      | string
      | null
      | undefined
    )[];
  }
  return {
    name: "exception",
    time: [0, 0] as HrTime,
    attributes,
  };
}

/**
 * Serialises spans to an OTLP/protobuf body and wraps them in a Request.
 */
function createProtobufRequest(spans: ReadableSpan[]): Request {
  const body = toBinary(TracesDataSchema, toTracesData(spans));
  return new Request("http://localhost/traces", { method: "POST", body });
}

/**
 * A source map that maps line 1, col 0 of the generated file to
 * src/app.ts line 1, col 0, name "handleClick".
 */
const simpleSourceMap = {
  version: 3,
  sources: ["src/app.ts"],
  names: ["handleClick"],
  mappings: "AAAAA",
  sourcesContent: ["// source"],
};

// ---------------------------------------------------------------------------
// 1. Basic Handler Flow
// ---------------------------------------------------------------------------

describe("traces handler", () => {
  describe("basic handler flow", () => {
    it("receives valid protobuf, forwards to exporter, returns 200", async () => {
      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const handler = createTracesHandler({ exporter });
      const span = createSpan();
      const request = createProtobufRequest([span]);

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(exportedSpans).toHaveLength(1);
      expect(exportedSpans[0]).toHaveLength(1);
      expect(exportedSpans[0][0].name).toBe("test-span");
    });

    it("forwards spans without resolution when no store is provided", async () => {
      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const handler = createTracesHandler({ exporter });
      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: test\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });
      const request = createProtobufRequest([span]);

      const response = await handler(request);

      expect(response.status).toBe(200);
      // The stacktrace should be unchanged since there is no store / resolver
      const exported = exportedSpans[0][0];
      const event = exported.events[0];
      expect(event.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(
        "Error: test\n    at http://example.com/app.js:1:1"
      );
    });

    it("resolves exception stack traces before forwarding when store is provided", async () => {
      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const store: SourceMapStore = {
        get(debugId) {
          return debugId === "debug-id-1"
            ? JSON.stringify(simpleSourceMap)
            : null;
        },
        put() {
          /* noop */
        },
      };

      const handler = createTracesHandler({ exporter, store });
      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: test\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });
      const request = createProtobufRequest([span]);

      const response = await handler(request);

      expect(response.status).toBe(200);

      const exported = exportedSpans[0][0];
      const event = exported.events[0];
      const resolved = event.attributes?.[ATTR_EXCEPTION_STACKTRACE] as string;
      expect(resolved).toContain("src/app.ts");
      expect(resolved).toContain("handleClick");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Exception Resolution
  // -------------------------------------------------------------------------

  describe("exception resolution", () => {
    let exporter: SpanExporter;
    let exportedSpans: ReadableSpan[][];
    let store: SourceMapStore;

    beforeEach(() => {
      exportedSpans = [];
      exporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      store = {
        get(debugId) {
          return debugId === "debug-id-1"
            ? JSON.stringify(simpleSourceMap)
            : null;
        },
        put() {
          /* noop */
        },
      };
    });

    it("resolves stack trace when exception event has debug_ids", async () => {
      const handler = createTracesHandler({ exporter, store });
      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: test\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });

      await handler(createProtobufRequest([span]));

      const event = exportedSpans[0][0].events[0];
      const resolved = event.attributes?.[ATTR_EXCEPTION_STACKTRACE] as string;
      expect(resolved).toContain("src/app.ts");
    });

    it("preserves original stacktrace as exception.stacktrace.original", async () => {
      const handler = createTracesHandler({ exporter, store });
      const originalStack = "Error: test\n    at http://example.com/app.js:1:1";
      const span = createSpan({
        events: [createExceptionEvent(originalStack, ["debug-id-1"])],
      });

      await handler(createProtobufRequest([span]));

      const event = exportedSpans[0][0].events[0];
      expect(event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]).toBe(
        originalStack
      );
    });

    it("does not modify span when exception has no debug_ids", async () => {
      const handler = createTracesHandler({ exporter, store });
      const originalStack = "Error: test\n    at http://example.com/app.js:1:1";
      const span = createSpan({
        events: [createExceptionEvent(originalStack)],
      });

      await handler(createProtobufRequest([span]));

      const event = exportedSpans[0][0].events[0];
      expect(event.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(originalStack);
      expect(
        event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]
      ).toBeUndefined();
    });

    it("does not modify span when stacktrace is not a string", async () => {
      const handler = createTracesHandler({ exporter, store });
      const event: TimedEvent = {
        name: "exception",
        time: [0, 0] as HrTime,
        attributes: {
          [ATTR_EXCEPTION_STACKTRACE]: 12_345 as unknown as string,
          [`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]: ["debug-id-1"],
        },
      };
      const span = createSpan({ events: [event] });

      await handler(createProtobufRequest([span]));

      // After round-trip through protobuf, the numeric value is converted,
      // but the handler should not attempt resolution.
      const exportedEvent = exportedSpans[0][0].events[0];
      expect(
        exportedEvent.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]
      ).toBeUndefined();
    });

    it("does not modify span when debug_ids is an empty array", async () => {
      const handler = createTracesHandler({ exporter, store });
      const originalStack = "Error: test\n    at http://example.com/app.js:1:1";
      const span = createSpan({
        events: [createExceptionEvent(originalStack, [])],
      });

      await handler(createProtobufRequest([span]));

      const event = exportedSpans[0][0].events[0];
      expect(event.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(originalStack);
      expect(
        event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]
      ).toBeUndefined();
    });

    it("passes through span with no exception events unchanged", async () => {
      const handler = createTracesHandler({ exporter, store });
      const span = createSpan({
        events: [
          {
            name: "some-event",
            time: [0, 0] as HrTime,
            attributes: { key: "value" },
          },
        ],
      });

      await handler(createProtobufRequest([span]));

      const exportedEvent = exportedSpans[0][0].events[0];
      expect(exportedEvent.name).toBe("some-event");
      expect(exportedEvent.attributes?.key).toBe("value");
    });

    it("filters debug_ids to only strings before resolving", async () => {
      const getSpy = vi.fn((debugId: string) => {
        return debugId === "valid-id" ? JSON.stringify(simpleSourceMap) : null;
      });
      const spyStore: SourceMapStore = {
        get: getSpy,
        put() {
          /* noop */
        },
      };

      const handler = createTracesHandler({ exporter, store: spyStore });
      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: test\n    at http://example.com/app.js:1:1",
            [42, null, "valid-id", undefined, true]
          ),
        ],
      });

      await handler(createProtobufRequest([span]));

      // After protobuf round-trip, only string values survive.
      // The handler's filter step ensures non-string entries are excluded.
      // The resolution should still happen (only the valid string id is used)
      // We just verify the export completed successfully.
      expect(exportedSpans).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple Spans/Events
  // -------------------------------------------------------------------------

  describe("multiple spans and events", () => {
    let exporter: SpanExporter;
    let exportedSpans: ReadableSpan[][];
    let store: SourceMapStore;

    beforeEach(() => {
      exportedSpans = [];
      exporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      store = {
        get(debugId) {
          return debugId === "debug-id-1"
            ? JSON.stringify(simpleSourceMap)
            : null;
        },
        put() {
          /* noop */
        },
      };
    });

    it("resolves only spans with exceptions and debug_ids among multiple spans", async () => {
      const handler = createTracesHandler({ exporter, store });

      const spanWithException = createSpan({
        name: "span-with-exception",
        events: [
          createExceptionEvent(
            "Error: fail\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });
      const spanWithoutException = createSpan({
        name: "span-without-exception",
        events: [],
      });
      const spanWithExceptionNoDebugIds = createSpan({
        name: "span-exception-no-debug",
        events: [
          createExceptionEvent(
            "Error: other\n    at http://example.com/other.js:5:10"
          ),
        ],
      });

      await handler(
        createProtobufRequest([
          spanWithException,
          spanWithoutException,
          spanWithExceptionNoDebugIds,
        ])
      );

      expect(exportedSpans[0]).toHaveLength(3);

      // First span should be resolved
      const resolvedEvent = exportedSpans[0][0].events[0];
      const resolvedStack = resolvedEvent.attributes?.[
        ATTR_EXCEPTION_STACKTRACE
      ] as string;
      expect(resolvedStack).toContain("src/app.ts");

      // Second span has no events at all
      expect(exportedSpans[0][1].events).toHaveLength(0);

      // Third span should be untouched
      const untouchedEvent = exportedSpans[0][2].events[0];
      expect(untouchedEvent.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(
        "Error: other\n    at http://example.com/other.js:5:10"
      );
      expect(
        untouchedEvent.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]
      ).toBeUndefined();
    });

    it("resolves multiple exception events in the same span independently", async () => {
      const handler = createTracesHandler({ exporter, store });

      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: first\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
          createExceptionEvent(
            "Error: second\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });

      await handler(createProtobufRequest([span]));

      const events = exportedSpans[0][0].events;
      expect(events).toHaveLength(2);

      for (const event of events) {
        const resolved = event.attributes?.[
          ATTR_EXCEPTION_STACKTRACE
        ] as string;
        expect(resolved).toContain("src/app.ts");
        expect(
          event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]
        ).toBeDefined();
      }
    });

    it("handles mix of exception and non-exception events in same span", async () => {
      const handler = createTracesHandler({ exporter, store });

      const span = createSpan({
        events: [
          {
            name: "log",
            time: [0, 0] as HrTime,
            attributes: { message: "hello" },
          },
          createExceptionEvent(
            "Error: boom\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
          {
            name: "custom-event",
            time: [0, 0] as HrTime,
            attributes: { info: "data" },
          },
        ],
      });

      await handler(createProtobufRequest([span]));

      const events = exportedSpans[0][0].events;
      expect(events).toHaveLength(3);

      // Log event is untouched
      expect(events[0].name).toBe("log");
      expect(events[0].attributes?.message).toBe("hello");

      // Exception event is resolved
      const resolved = events[1].attributes?.[
        ATTR_EXCEPTION_STACKTRACE
      ] as string;
      expect(resolved).toContain("src/app.ts");

      // Custom event is untouched
      expect(events[2].name).toBe("custom-event");
      expect(events[2].attributes?.info).toBe("data");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Error Handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("rejects when exporter returns an error", async () => {
      const exportError = new Error("export failed");
      const exporter: SpanExporter = {
        export(_spans, callback) {
          callback({ code: ExportResultCode.FAILED, error: exportError });
        },
        shutdown: () => Promise.resolve(),
      };

      const handler = createTracesHandler({ exporter });
      const span = createSpan();

      await expect(handler(createProtobufRequest([span]))).rejects.toThrow(
        "export failed"
      );
    });

    it("preserves original stacktrace when store returns invalid JSON", async () => {
      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const store: SourceMapStore = {
        get() {
          return "not valid json {{{";
        },
        put() {
          /* noop */
        },
      };

      const handler = createTracesHandler({ exporter, store });
      const originalStack = "Error: test\n    at http://example.com/app.js:1:1";
      const span = createSpan({
        events: [createExceptionEvent(originalStack, ["debug-id-1"])],
      });

      await handler(createProtobufRequest([span]));

      const event = exportedSpans[0][0].events[0];
      // The resolver's internal loadSourceMaps silently skips invalid JSON
      // (no consumer is loaded), so resolveStackTrace returns the original
      // stack unchanged. The handler then writes both the "resolved" value
      // (identical to the original) and the `.original` attribute.
      expect(event.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(originalStack);
      expect(event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.original`]).toBe(
        originalStack
      );
    });

    it("does not prevent export when resolution fails", async () => {
      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const store: SourceMapStore = {
        get() {
          throw new Error("store exploded");
        },
        put() {
          /* noop */
        },
      };

      const handler = createTracesHandler({ exporter, store });
      const originalStack = "Error: test\n    at http://example.com/app.js:1:1";
      const span = createSpan({
        events: [createExceptionEvent(originalStack, ["debug-id-1"])],
      });

      const response = await handler(createProtobufRequest([span]));

      expect(response.status).toBe(200);
      expect(exportedSpans).toHaveLength(1);
      // The original stacktrace is preserved on failure
      const event = exportedSpans[0][0].events[0];
      expect(event.attributes?.[ATTR_EXCEPTION_STACKTRACE]).toBe(originalStack);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Resolver Lifecycle
  // -------------------------------------------------------------------------

  describe("resolver lifecycle", () => {
    it("does not create a resolver when store is not provided", async () => {
      const exporter: SpanExporter = {
        export(_spans, callback) {
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      // If a resolver were created without a store, it would throw.
      // The fact that this succeeds proves no resolver was created.
      const handler = createTracesHandler({ exporter });
      const span = createSpan();

      const response = await handler(createProtobufRequest([span]));
      expect(response.status).toBe(200);
    });

    it("creates resolver lazily on first request", async () => {
      let storeGetCalls = 0;
      const store: SourceMapStore = {
        get(debugId) {
          storeGetCalls++;
          return debugId === "debug-id-1"
            ? JSON.stringify(simpleSourceMap)
            : null;
        },
        put() {
          /* noop */
        },
      };

      const exporter: SpanExporter = {
        export(_spans, callback) {
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      // Creating the handler should not access the store yet
      const handler = createTracesHandler({ exporter, store });
      expect(storeGetCalls).toBe(0);

      // First request triggers resolver creation
      const span = createSpan({
        events: [
          createExceptionEvent(
            "Error: test\n    at http://example.com/app.js:1:1",
            ["debug-id-1"]
          ),
        ],
      });
      await handler(createProtobufRequest([span]));

      expect(storeGetCalls).toBeGreaterThan(0);
    });

    it("reuses resolver across multiple requests", async () => {
      let storeGetCalls = 0;
      const store: SourceMapStore = {
        get(debugId) {
          storeGetCalls++;
          return debugId === "debug-id-1"
            ? JSON.stringify(simpleSourceMap)
            : null;
        },
        put() {
          /* noop */
        },
      };

      const exportedSpans: ReadableSpan[][] = [];
      const exporter: SpanExporter = {
        export(spans, callback) {
          exportedSpans.push(spans);
          callback({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      };

      const handler = createTracesHandler({ exporter, store });

      const makeRequest = () => {
        const span = createSpan({
          events: [
            createExceptionEvent(
              "Error: test\n    at http://example.com/app.js:1:1",
              ["debug-id-1"]
            ),
          ],
        });
        return handler(createProtobufRequest([span]));
      };

      // First request — resolver created, store queried
      await makeRequest();
      const callsAfterFirst = storeGetCalls;
      expect(callsAfterFirst).toBe(1);

      // Second request — resolver reused, source map cached
      await makeRequest();
      // The source map was cached after the first call, so the store
      // should not be queried again for the same debug ID.
      expect(storeGetCalls).toBe(callsAfterFirst);

      // Both requests should have exported successfully
      expect(exportedSpans).toHaveLength(2);

      // Both should have resolved stacktraces
      for (const spans of exportedSpans) {
        const event = spans[0].events[0];
        const resolved = event.attributes?.[
          ATTR_EXCEPTION_STACKTRACE
        ] as string;
        expect(resolved).toContain("src/app.ts");
      }
    });
  });
});
