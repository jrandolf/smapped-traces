import { fromBinary } from "@bufbuild/protobuf";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_EXCEPTION_STACKTRACE } from "@opentelemetry/semantic-conventions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TracesDataSchema } from "../generated/opentelemetry/proto/trace/v1/trace_pb.js";
import { resetDebugIdCache } from "./debug-ids.js";
import { SourceMappedSpanExporter } from "./exporter.js";

const TEST_URL = "https://example.com/v1/traces";

function createMockSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "test-span",
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    }),
    parentSpanContext: undefined,
    startTime: [1000, 0],
    endTime: [1001, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  } as ReadableSpan;
}

function createExceptionSpan(stacktrace: string): ReadableSpan {
  return createMockSpan({
    events: [
      {
        name: "exception",
        time: [1000, 500] as [number, number],
        attributes: {
          [ATTR_EXCEPTION_STACKTRACE]: stacktrace,
        },
      },
    ],
  });
}

function exportAsync(
  exporter: SourceMappedSpanExporter,
  spans: ReadableSpan[]
): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export(spans, resolve);
  });
}

beforeEach(() => {
  resetDebugIdCache();
  // Clean up debug ID globals
  (globalThis as Record<string, unknown>)._debugIds = undefined;
  (globalThis as Record<string, unknown>).__DEBUG_IDS__ = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDebugIdCache();
  (globalThis as Record<string, unknown>)._debugIds = undefined;
  (globalThis as Record<string, unknown>).__DEBUG_IDS__ = undefined;
});

describe("SourceMappedSpanExporter", () => {
  describe("State Machine - Fetch Mode (Initial)", () => {
    it("first export uses fetch with correct URL, POST method, and binary body", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      const span = createMockSpan();

      await exportAsync(exporter, [span]);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(TEST_URL);
      expect(options.method).toBe("POST");
      expect(options.body).toBeInstanceOf(Uint8Array);
    });

    it("successful 200 response calls resultCallback with SUCCESS", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      const result = await exportAsync(exporter, [createMockSpan()]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
    });

    it("successful 200 response transitions to sendBeacon mode", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);

      // First export: uses fetch
      await exportAsync(exporter, [createMockSpan()]);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockSendBeacon).not.toHaveBeenCalled();

      // Second export: should use sendBeacon
      await exportAsync(exporter, [createMockSpan()]);
      expect(mockFetch).toHaveBeenCalledOnce(); // still only once
      expect(mockSendBeacon).toHaveBeenCalledOnce();
    });
  });

  describe("State Machine - SendBeacon Mode", () => {
    it("after 200 response, subsequent exports use navigator.sendBeacon", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);

      // Transition to sendBeacon mode
      await exportAsync(exporter, [createMockSpan()]);

      // Now use sendBeacon
      await exportAsync(exporter, [createMockSpan()]);

      expect(mockSendBeacon).toHaveBeenCalledOnce();
      const [url, body] = mockSendBeacon.mock.calls[0]!;
      expect(url).toBe(TEST_URL);
      expect(body).toBeInstanceOf(Uint8Array);
    });

    it("sendBeacon returning true calls resultCallback with SUCCESS", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [createMockSpan()]); // transition

      const result = await exportAsync(exporter, [createMockSpan()]);
      expect(result.code).toBe(ExportResultCode.SUCCESS);
    });

    it("sendBeacon returning false calls resultCallback with FAILED", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(false);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [createMockSpan()]); // transition

      const result = await exportAsync(exporter, [createMockSpan()]);
      expect(result.code).toBe(ExportResultCode.FAILED);
    });
  });

  describe("State Machine - Disabled Mode", () => {
    it("204 response transitions to disabled state", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);

      // First export: fetch returns 204
      const result = await exportAsync(exporter, [createMockSpan()]);
      expect(result.code).toBe(ExportResultCode.SUCCESS);

      // Second export: should be disabled
      mockFetch.mockClear();
      const result2 = await exportAsync(exporter, [createMockSpan()]);
      expect(result2.code).toBe(ExportResultCode.SUCCESS);

      // Neither fetch nor sendBeacon should have been called
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSendBeacon).not.toHaveBeenCalled();
    });

    it("in disabled state, export returns SUCCESS immediately", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [createMockSpan()]); // transition to disabled

      mockFetch.mockClear();

      const result = await exportAsync(exporter, [createMockSpan()]);
      expect(result.code).toBe(ExportResultCode.SUCCESS);
    });

    it("in disabled state, neither fetch nor sendBeacon is called", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const mockSendBeacon = vi.fn().mockReturnValue(true);
      vi.stubGlobal("navigator", { sendBeacon: mockSendBeacon });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [createMockSpan()]); // transition to disabled

      mockFetch.mockClear();

      await exportAsync(exporter, [createMockSpan()]);
      await exportAsync(exporter, [createMockSpan()]);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockSendBeacon).not.toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("non-ok fetch response returns FAILED with error containing response text", async () => {
      const errorMessage = "Internal Server Error";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(errorMessage),
      });
      vi.stubGlobal("fetch", mockFetch);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      const result = await exportAsync(exporter, [createMockSpan()]);

      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error!.message).toBe(errorMessage);
    });

    it("fetch returns error text in the Error object", async () => {
      const detailedError = "Bad Request: invalid protobuf payload";
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve(detailedError),
      });
      vi.stubGlobal("fetch", mockFetch);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      const result = await exportAsync(exporter, [createMockSpan()]);

      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error!.message).toBe(detailedError);
    });
  });

  describe("Debug ID Enrichment", () => {
    const CHUNK_URL = "http://localhost:3000/_next/static/chunks/page.js";
    const DEBUG_ID = "abc123-def456-ghi789";

    const STACKTRACE = [
      "Error: something went wrong",
      `    at Object.<anonymous> (${CHUNK_URL}:10:15)`,
      "    at Module._compile (node:internal/modules/cjs/loader:1241:14)",
    ].join("\n");

    it("exception event with stacktrace matching _debugIds gets debug_ids attribute added", async () => {
      // Set up _debugIds global (Turbopack style: stack trace keys)
      const turbopackStack = ["Error", `    at ${CHUNK_URL}:1:172`].join("\n");

      (globalThis as Record<string, unknown>)._debugIds = {
        [turbopackStack]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createExceptionSpan(STACKTRACE);
      const exporter = new SourceMappedSpanExporter(TEST_URL);

      await exportAsync(exporter, [span]);

      // Verify the event was enriched
      const event = span.events[0]!;
      expect(
        event.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toEqual([DEBUG_ID]);
    });

    it("exception event with stacktrace matching __DEBUG_IDS__ gets debug_ids attribute added", async () => {
      // Set up __DEBUG_IDS__ global (TC39 / webpack style: URL keys)
      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createExceptionSpan(STACKTRACE);
      const exporter = new SourceMappedSpanExporter(TEST_URL);

      await exportAsync(exporter, [span]);

      const event = span.events[0]!;
      expect(
        event.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toEqual([DEBUG_ID]);
    });

    it("non-exception events are not enriched", async () => {
      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createMockSpan({
        events: [
          {
            name: "custom-event",
            time: [1000, 500] as [number, number],
            attributes: {
              [ATTR_EXCEPTION_STACKTRACE]: STACKTRACE,
            },
          },
        ],
      });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [span]);

      const event = span.events[0]!;
      expect(
        event.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toBeUndefined();
    });

    it("exception event without stacktrace is not enriched", async () => {
      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createMockSpan({
        events: [
          {
            name: "exception",
            time: [1000, 500] as [number, number],
            attributes: {},
          },
        ],
      });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [span]);

      const event = span.events[0]!;
      expect(
        event.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toBeUndefined();
    });

    it("exception event with non-string stacktrace is not enriched", async () => {
      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createMockSpan({
        events: [
          {
            name: "exception",
            time: [1000, 500] as [number, number],
            attributes: {
              [ATTR_EXCEPTION_STACKTRACE]: 12_345,
            },
          },
        ],
      });

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [span]);

      const event = span.events[0]!;
      expect(
        event.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toBeUndefined();
    });

    it("span with no events is not enriched", async () => {
      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const span = createMockSpan({ events: [] });
      const exporter = new SourceMappedSpanExporter(TEST_URL);

      await exportAsync(exporter, [span]);

      // Just verify it doesn't throw and export completes
      expect(span.events).toHaveLength(0);
    });

    it("multiple exception events in different spans are each enriched independently", async () => {
      const CHUNK_URL_2 = "http://localhost:3000/_next/static/chunks/other.js";
      const DEBUG_ID_2 = "xyz789-uvw456";

      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
        [CHUNK_URL_2]: DEBUG_ID_2,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const stacktrace1 = [
        "Error: first error",
        `    at foo (${CHUNK_URL}:10:15)`,
      ].join("\n");

      const stacktrace2 = [
        "Error: second error",
        `    at bar (${CHUNK_URL_2}:20:30)`,
      ].join("\n");

      const span1 = createExceptionSpan(stacktrace1);
      const span2 = createExceptionSpan(stacktrace2);

      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await exportAsync(exporter, [span1, span2]);

      expect(
        span1.events[0]!.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toEqual([DEBUG_ID]);
      expect(
        span2.events[0]!.attributes![`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
      ).toEqual([DEBUG_ID_2]);
    });
  });

  describe("forceFlush and shutdown", () => {
    it("forceFlush resolves immediately", async () => {
      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    });

    it("shutdown resolves immediately", async () => {
      const exporter = new SourceMappedSpanExporter(TEST_URL);
      await expect(exporter.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("Integration", () => {
    it("full flow: set debug IDs, create span with exception, export, verify fetch receives enriched protobuf data", async () => {
      const CHUNK_URL = "http://localhost:3000/app.js";
      const DEBUG_ID = "integration-debug-id-001";

      (globalThis as Record<string, unknown>).__DEBUG_IDS__ = {
        [CHUNK_URL]: DEBUG_ID,
      };

      let capturedBody: Uint8Array | undefined;
      const mockFetch = vi.fn().mockImplementation((_url, init) => {
        capturedBody = init.body;
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(""),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const stacktrace = [
        "TypeError: Cannot read properties of undefined",
        `    at render (${CHUNK_URL}:42:10)`,
        `    at mount (${CHUNK_URL}:100:5)`,
      ].join("\n");

      const span = createExceptionSpan(stacktrace);
      const exporter = new SourceMappedSpanExporter(TEST_URL);

      const result = await exportAsync(exporter, [span]);
      expect(result.code).toBe(ExportResultCode.SUCCESS);

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledOnce();

      // Decode the protobuf body
      expect(capturedBody).toBeInstanceOf(Uint8Array);
      const tracesData = fromBinary(TracesDataSchema, capturedBody!);

      // Verify structure
      expect(tracesData.resourceSpans).toHaveLength(1);
      const scopeSpans = tracesData.resourceSpans[0]!.scopeSpans;
      expect(scopeSpans).toHaveLength(1);
      const spans = scopeSpans[0]!.spans;
      expect(spans).toHaveLength(1);

      const protoSpan = spans[0]!;
      expect(protoSpan.name).toBe("test-span");
      expect(protoSpan.events).toHaveLength(1);

      const event = protoSpan.events[0]!;
      expect(event.name).toBe("exception");

      // Find the debug_ids attribute in the protobuf event
      const debugIdsAttr = event.attributes.find(
        (attr) => attr.key === `${ATTR_EXCEPTION_STACKTRACE}.debug_ids`
      );
      expect(debugIdsAttr).toBeDefined();

      // The debug_ids value should be an array containing our debug ID
      const arrayValue = debugIdsAttr!.value?.value;
      expect(arrayValue).toMatchObject({
        case: "arrayValue",
      });

      if (arrayValue?.case === "arrayValue") {
        const items = arrayValue.value.values;
        expect(items).toHaveLength(1);
        expect(items[0]?.value).toMatchObject({
          case: "stringValue",
          value: DEBUG_ID,
        });
      }
    });
  });
});
