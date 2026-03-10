import { create } from "@bufbuild/protobuf";
import {
  type Attributes,
  type HrTime,
  type Link,
  SpanKind,
  type SpanStatus,
  SpanStatusCode,
  TraceFlags,
} from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { fromTracesData, toTracesData } from "./convert.js";
import { TracesDataSchema } from "./generated/opentelemetry/proto/trace/v1/trace_pb.js";

// ============================================================================
// Helpers
// ============================================================================

function createMockSpan(
  overrides: Partial<{
    name: string;
    kind: SpanKind;
    traceId: string;
    spanId: string;
    parentSpanId: string;
    traceFlags: number;
    startTime: HrTime;
    endTime: HrTime;
    status: SpanStatus;
    attributes: Attributes;
    links: Link[];
    events: TimedEvent[];
    resource: ReturnType<typeof resourceFromAttributes>;
    instrumentationScope: InstrumentationScope;
    droppedAttributesCount: number;
    droppedEventsCount: number;
    droppedLinksCount: number;
  }> = {}
): ReadableSpan {
  const traceId = overrides.traceId ?? "0af7651916cd43dd8448eb211c80319c";
  const spanId = overrides.spanId ?? "b7ad6b7169203331";
  const traceFlags = overrides.traceFlags ?? TraceFlags.SAMPLED;

  const parentSpanContext = overrides.parentSpanId
    ? {
        traceId,
        spanId: overrides.parentSpanId,
        traceFlags,
        isRemote: true,
      }
    : undefined;

  const resource =
    overrides.resource ??
    resourceFromAttributes({ "service.name": "test-service" });

  const instrumentationScope: InstrumentationScope =
    overrides.instrumentationScope ?? {
      name: "test-scope",
      version: "1.0.0",
    };

  const startTime: HrTime = overrides.startTime ?? [1_700_000_000, 0];
  const endTime: HrTime = overrides.endTime ?? [1_700_000_001, 0];

  // Calculate duration
  const durationSec = endTime[0] - startTime[0];
  const durationNano = endTime[1] - startTime[1];
  const totalNano = durationSec * 1_000_000_000 + durationNano;
  const duration: HrTime = [
    Math.floor(totalNano / 1_000_000_000),
    totalNano % 1_000_000_000,
  ];

  return {
    name: overrides.name ?? "test-span",
    kind: overrides.kind ?? SpanKind.INTERNAL,
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags,
      isRemote: false,
    }),
    parentSpanContext,
    startTime,
    endTime,
    status: overrides.status ?? { code: SpanStatusCode.UNSET },
    attributes: overrides.attributes ?? {},
    links: overrides.links ?? [],
    events: overrides.events ?? [],
    duration,
    ended: true,
    resource,
    instrumentationScope,
    droppedAttributesCount: overrides.droppedAttributesCount ?? 0,
    droppedEventsCount: overrides.droppedEventsCount ?? 0,
    droppedLinksCount: overrides.droppedLinksCount ?? 0,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Round-trip Conversion Fidelity", () => {
  it("single span with all fields populated round-trips correctly", () => {
    const span = createMockSpan({
      name: "full-span",
      kind: SpanKind.SERVER,
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      parentSpanId: "00f067aa0ba902b7",
      startTime: [1_700_000_000, 123_456_789],
      endTime: [1_700_000_002, 987_654_321],
      status: { code: SpanStatusCode.OK, message: "all good" },
      attributes: { "http.method": "GET", "http.status_code": 200 },
      events: [
        {
          name: "event1",
          time: [1_700_000_001, 0] as HrTime,
          attributes: { key: "value" },
          droppedAttributesCount: 0,
        },
      ],
      links: [
        {
          context: {
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "1234567890abcdef",
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
          },
          attributes: { "link.attr": "linked" },
          droppedAttributesCount: 0,
        },
      ],
      droppedAttributesCount: 1,
      droppedEventsCount: 2,
      droppedLinksCount: 3,
    });

    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result).toHaveLength(1);
    const out = result[0]!;
    expect(out.name).toBe("full-span");
    expect(out.kind).toBe(SpanKind.SERVER);
    expect(out.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(out.spanContext().spanId).toBe("b7ad6b7169203331");
    expect(out.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(out.startTime).toEqual([1_700_000_000, 123_456_789]);
    expect(out.endTime).toEqual([1_700_000_002, 987_654_321]);
    expect(out.status.code).toBe(SpanStatusCode.OK);
    expect(out.status.message).toBe("all good");
    expect(out.attributes).toEqual({
      "http.method": "GET",
      "http.status_code": 200,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.name).toBe("event1");
    expect(out.links).toHaveLength(1);
    expect(out.links[0]!.context.spanId).toBe("1234567890abcdef");
    expect(out.droppedAttributesCount).toBe(1);
    expect(out.droppedEventsCount).toBe(2);
    expect(out.droppedLinksCount).toBe(3);
  });

  it("multiple spans with same resource are grouped together", () => {
    const resource = resourceFromAttributes({ "service.name": "shared" });
    const scope: InstrumentationScope = { name: "scope1", version: "1.0.0" };
    const span1 = createMockSpan({
      name: "span1",
      resource,
      instrumentationScope: scope,
      spanId: "aaaaaaaaaaaaaaaa",
    });
    const span2 = createMockSpan({
      name: "span2",
      resource,
      instrumentationScope: scope,
      spanId: "bbbbbbbbbbbbbbbb",
    });

    const tracesData = toTracesData([span1, span2]);

    expect(tracesData.resourceSpans).toHaveLength(1);
    expect(tracesData.resourceSpans[0]!.scopeSpans).toHaveLength(1);
    expect(tracesData.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(2);

    const result = fromTracesData(tracesData);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("span1");
    expect(result[1]!.name).toBe("span2");
  });

  it("multiple spans with different resources create separate ResourceSpans", () => {
    const resource1 = resourceFromAttributes({ "service.name": "svc1" });
    const resource2 = resourceFromAttributes({ "service.name": "svc2" });
    const span1 = createMockSpan({
      name: "span1",
      resource: resource1,
      spanId: "aaaaaaaaaaaaaaaa",
    });
    const span2 = createMockSpan({
      name: "span2",
      resource: resource2,
      spanId: "bbbbbbbbbbbbbbbb",
    });

    const tracesData = toTracesData([span1, span2]);

    expect(tracesData.resourceSpans).toHaveLength(2);

    const result = fromTracesData(tracesData);
    expect(result).toHaveLength(2);
  });

  it("multiple spans with same resource but different scopes create separate ScopeSpans", () => {
    const resource = resourceFromAttributes({ "service.name": "shared" });
    const scope1: InstrumentationScope = { name: "scope-a", version: "1.0.0" };
    const scope2: InstrumentationScope = { name: "scope-b", version: "2.0.0" };
    const span1 = createMockSpan({
      name: "span1",
      resource,
      instrumentationScope: scope1,
      spanId: "aaaaaaaaaaaaaaaa",
    });
    const span2 = createMockSpan({
      name: "span2",
      resource,
      instrumentationScope: scope2,
      spanId: "bbbbbbbbbbbbbbbb",
    });

    const tracesData = toTracesData([span1, span2]);

    expect(tracesData.resourceSpans).toHaveLength(1);
    expect(tracesData.resourceSpans[0]!.scopeSpans).toHaveLength(2);

    const result = fromTracesData(tracesData);
    expect(result).toHaveLength(2);
    expect(result[0]!.instrumentationScope.name).toBe("scope-a");
    expect(result[1]!.instrumentationScope.name).toBe("scope-b");
  });

  it("empty spans array produces empty TracesData and vice versa", () => {
    const tracesData = toTracesData([]);
    expect(tracesData.resourceSpans).toHaveLength(0);

    const result = fromTracesData(tracesData);
    expect(result).toHaveLength(0);
  });
});

describe("Attribute Type Conversion", () => {
  function roundTripAttributes(attrs: Attributes): Attributes {
    const span = createMockSpan({ attributes: attrs });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    return result[0]!.attributes;
  }

  it("string attribute round-trips", () => {
    const attrs = roundTripAttributes({ greeting: "hello" });
    expect(attrs.greeting).toBe("hello");
  });

  it("boolean attribute round-trips (true and false)", () => {
    const attrs = roundTripAttributes({ yes: true, no: false });
    expect(attrs.yes).toBe(true);
    expect(attrs.no).toBe(false);
  });

  it("integer number converts to intValue and back", () => {
    const attrs = roundTripAttributes({ count: 42 });
    expect(attrs.count).toBe(42);
  });

  it("float number converts to doubleValue and back", () => {
    const attrs = roundTripAttributes({ ratio: 3.14 });
    expect(attrs.ratio).toBeCloseTo(3.14);
  });

  it("array of strings round-trips", () => {
    const attrs = roundTripAttributes({ tags: ["a", "b", "c"] });
    expect(attrs.tags).toEqual(["a", "b", "c"]);
  });

  it("array of numbers round-trips", () => {
    const attrs = roundTripAttributes({ values: [1, 2, 3] });
    expect(attrs.values).toEqual([1, 2, 3]);
  });

  it("mixed array with null/undefined filtered", () => {
    // The OTel AttributeValue type allows (string | number | boolean | null | undefined)[]
    // The conversion filters out null/undefined
    const attrs = roundTripAttributes({
      mixed: [
        "a",
        null as unknown as string,
        "b",
        undefined as unknown as string,
      ],
    });
    expect(attrs.mixed).toEqual(["a", "b"]);
  });

  it("empty attributes object", () => {
    const attrs = roundTripAttributes({});
    expect(attrs).toEqual({});
  });

  it("zero (0) is treated as integer", () => {
    const attrs = roundTripAttributes({ zero: 0 });
    expect(attrs.zero).toBe(0);
  });
});

describe("Span Kind Conversion", () => {
  const kinds = [
    SpanKind.INTERNAL,
    SpanKind.SERVER,
    SpanKind.CLIENT,
    SpanKind.PRODUCER,
    SpanKind.CONSUMER,
  ] as const;

  for (const kind of kinds) {
    it(`SpanKind ${SpanKind[kind]} round-trips`, () => {
      const span = createMockSpan({ kind });
      const tracesData = toTracesData([span]);
      const result = fromTracesData(tracesData);
      expect(result[0]!.kind).toBe(kind);
    });
  }
});

describe("Status Code Conversion", () => {
  it("UNSET round-trips", () => {
    const span = createMockSpan({ status: { code: SpanStatusCode.UNSET } });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("OK round-trips", () => {
    const span = createMockSpan({ status: { code: SpanStatusCode.OK } });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.status.code).toBe(SpanStatusCode.OK);
  });

  it("ERROR round-trips", () => {
    const span = createMockSpan({ status: { code: SpanStatusCode.ERROR } });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("status message is preserved", () => {
    const span = createMockSpan({
      status: { code: SpanStatusCode.ERROR, message: "something broke" },
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.status.message).toBe("something broke");
  });
});

describe("Time Conversion", () => {
  it("HrTime [0, 0] round-trips", () => {
    const span = createMockSpan({
      startTime: [0, 0],
      endTime: [0, 0],
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.startTime).toEqual([0, 0]);
    expect(result[0]!.endTime).toEqual([0, 0]);
  });

  it("HrTime with large seconds round-trips", () => {
    const span = createMockSpan({
      startTime: [1_700_000_000, 500_000_000],
      endTime: [1_700_001_000, 500_000_000],
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.startTime).toEqual([1_700_000_000, 500_000_000]);
    expect(result[0]!.endTime).toEqual([1_700_001_000, 500_000_000]);
  });

  it("HrTime with max nanoseconds [1, 999999999] round-trips", () => {
    const span = createMockSpan({
      startTime: [1, 999_999_999],
      endTime: [2, 999_999_999],
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.startTime).toEqual([1, 999_999_999]);
    expect(result[0]!.endTime).toEqual([2, 999_999_999]);
  });

  it("duration is calculated correctly from start/end times", () => {
    const span = createMockSpan({
      startTime: [1_700_000_000, 200_000_000],
      endTime: [1_700_000_003, 700_000_000],
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    // 3 seconds + 500_000_000 nanoseconds = [3, 500000000]
    expect(result[0]!.duration).toEqual([3, 500_000_000]);
  });
});

describe("Trace/Span ID Conversion", () => {
  it("32-char hex trace ID round-trips through bytes", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const span = createMockSpan({ traceId });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.spanContext().traceId).toBe(traceId);
  });

  it("16-char hex span ID round-trips through bytes", () => {
    const spanId = "b7ad6b7169203331";
    const span = createMockSpan({ spanId });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.spanContext().spanId).toBe(spanId);
  });

  it("leading zeros are preserved", () => {
    const traceId = "00000000000000000000000000000001";
    const spanId = "0000000000000001";
    const span = createMockSpan({ traceId, spanId });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);
    expect(result[0]!.spanContext().traceId).toBe(traceId);
    expect(result[0]!.spanContext().spanId).toBe(spanId);
  });
});

describe("Event Conversion", () => {
  it("exception event with attributes round-trips", () => {
    const events: TimedEvent[] = [
      {
        name: "exception",
        time: [1_700_000_001, 500_000_000] as HrTime,
        attributes: {
          "exception.type": "Error",
          "exception.message": "something failed",
          "exception.stacktrace": "Error: something failed\n    at main()",
        },
        droppedAttributesCount: 0,
      },
    ];
    const span = createMockSpan({ events });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.events).toHaveLength(1);
    const event = result[0]!.events[0]!;
    expect(event.name).toBe("exception");
    expect(event.time).toEqual([1_700_000_001, 500_000_000]);
    expect(event.attributes!["exception.type"]).toBe("Error");
    expect(event.attributes!["exception.message"]).toBe("something failed");
    expect(event.attributes!["exception.stacktrace"]).toBe(
      "Error: something failed\n    at main()"
    );
  });

  it("event with droppedAttributesCount preserves the count", () => {
    const events: TimedEvent[] = [
      {
        name: "event-with-drops",
        time: [1_700_000_001, 0] as HrTime,
        attributes: {},
        droppedAttributesCount: 5,
      },
    ];
    const span = createMockSpan({ events });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.events[0]!.droppedAttributesCount).toBe(5);
  });

  it("multiple events in a span all round-trip", () => {
    const events: TimedEvent[] = [
      {
        name: "event-a",
        time: [1_700_000_001, 0] as HrTime,
        attributes: { order: 1 },
        droppedAttributesCount: 0,
      },
      {
        name: "event-b",
        time: [1_700_000_002, 0] as HrTime,
        attributes: { order: 2 },
        droppedAttributesCount: 0,
      },
      {
        name: "event-c",
        time: [1_700_000_003, 0] as HrTime,
        attributes: { order: 3 },
        droppedAttributesCount: 0,
      },
    ];
    const span = createMockSpan({ events });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.events).toHaveLength(3);
    expect(result[0]!.events[0]!.name).toBe("event-a");
    expect(result[0]!.events[1]!.name).toBe("event-b");
    expect(result[0]!.events[2]!.name).toBe("event-c");
  });
});

describe("Link Conversion", () => {
  it("link with traceId, spanId, attributes round-trips", () => {
    const links: Link[] = [
      {
        context: {
          traceId: "abcdef0123456789abcdef0123456789",
          spanId: "1122334455667788",
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        },
        attributes: { "link.name": "upstream" },
        droppedAttributesCount: 0,
      },
    ];
    const span = createMockSpan({ links });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.links).toHaveLength(1);
    const link = result[0]!.links[0]!;
    expect(link.context.traceId).toBe("abcdef0123456789abcdef0123456789");
    expect(link.context.spanId).toBe("1122334455667788");
    expect(link.context.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(link.attributes!["link.name"]).toBe("upstream");
  });

  it("link with droppedAttributesCount preserves count", () => {
    const links: Link[] = [
      {
        context: {
          traceId: "abcdef0123456789abcdef0123456789",
          spanId: "1122334455667788",
          traceFlags: TraceFlags.NONE,
          isRemote: true,
        },
        attributes: {},
        droppedAttributesCount: 7,
      },
    ];
    const span = createMockSpan({ links });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.links[0]!.droppedAttributesCount).toBe(7);
  });
});

describe("Parent Span Context", () => {
  it("span with parentSpanContext round-trips (parentSpanId preserved)", () => {
    const span = createMockSpan({ parentSpanId: "00f067aa0ba902b7" });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.parentSpanContext).toBeDefined();
    expect(result[0]!.parentSpanContext!.spanId).toBe("00f067aa0ba902b7");
  });

  it("span without parent has undefined parentSpanContext after round-trip", () => {
    const span = createMockSpan(); // no parentSpanId
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.parentSpanContext).toBeUndefined();
  });
});

describe("Edge Cases", () => {
  it("span with no events, no links, no attributes", () => {
    const span = createMockSpan({
      attributes: {},
      events: [],
      links: [],
    });
    const tracesData = toTracesData([span]);
    const result = fromTracesData(tracesData);

    expect(result[0]!.attributes).toEqual({});
    expect(result[0]!.events).toEqual([]);
    expect(result[0]!.links).toEqual([]);
  });

  it("fromTracesData with empty resourceSpans", () => {
    const tracesData = create(TracesDataSchema, { resourceSpans: [] });
    const result = fromTracesData(tracesData);
    expect(result).toEqual([]);
  });
});
