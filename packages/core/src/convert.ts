/**
 * Conversion utilities between OpenTelemetry SDK types and OTLP protobuf types.
 *
 * Provides bidirectional conversion for trace data (ReadableSpan <-> protobuf).
 */

import { create } from "@bufbuild/protobuf";
import {
  type Attributes,
  type AttributeValue,
  type HrTime,
  type Link,
  SpanKind,
  type SpanStatus,
  SpanStatusCode,
} from "@opentelemetry/api";
import type { InstrumentationScope } from "@opentelemetry/core";
import type { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import {
  type AnyValue,
  AnyValueSchema,
  InstrumentationScopeSchema,
  type KeyValue,
  KeyValueSchema,
  type InstrumentationScope as ProtoInstrumentationScope,
} from "./generated/opentelemetry/proto/common/v1/common_pb.js";
import {
  type Resource as ProtoResource,
  ResourceSchema,
} from "./generated/opentelemetry/proto/resource/v1/resource_pb.js";
import {
  type ResourceSpans,
  ResourceSpansSchema,
  type ScopeSpans,
  ScopeSpansSchema,
  type Span,
  type Span_Event,
  Span_EventSchema,
  type Span_Link,
  Span_LinkSchema,
  Span_SpanKind,
  SpanSchema,
  type Status,
  Status_StatusCode,
  StatusSchema,
  type TracesData,
  TracesDataSchema,
} from "./generated/opentelemetry/proto/trace/v1/trace_pb.js";

// ============================================================================
// Common Conversions
// ============================================================================

/**
 * Convert HrTime (high-resolution time) to nanoseconds as bigint.
 * HrTime is [seconds, nanoseconds].
 */
function hrTimeToNanos(hrTime: HrTime): bigint {
  const [seconds, nanos] = hrTime;
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
}

/**
 * Convert a hex string to Uint8Array.
 * Used for converting trace IDs and span IDs.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert an AttributeValue to protobuf AnyValue.
 */
function toAnyValue(value: AttributeValue): AnyValue {
  if (typeof value === "string") {
    return create(AnyValueSchema, {
      value: { case: "stringValue", value },
    });
  }
  if (typeof value === "boolean") {
    return create(AnyValueSchema, {
      value: { case: "boolValue", value },
    });
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return create(AnyValueSchema, {
        value: { case: "intValue", value: BigInt(value) },
      });
    }
    return create(AnyValueSchema, {
      value: { case: "doubleValue", value },
    });
  }
  if (Array.isArray(value)) {
    const values: AnyValue[] = [];
    for (const item of value) {
      if (item !== null && item !== undefined) {
        values.push(toAnyValue(item));
      }
    }
    return create(AnyValueSchema, {
      value: {
        case: "arrayValue",
        value: { values },
      },
    });
  }
  return create(AnyValueSchema, {});
}

/**
 * Convert Attributes to protobuf KeyValue array.
 */
function toKeyValues(attributes: Attributes | undefined): KeyValue[] {
  if (!attributes) {
    return [];
  }
  const result: KeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      result.push(
        create(KeyValueSchema, {
          key,
          value: toAnyValue(value),
        })
      );
    }
  }
  return result;
}

/**
 * Convert SDK Resource to protobuf Resource.
 */
function toProtoResource(resource: Resource): ProtoResource {
  return create(ResourceSchema, {
    attributes: toKeyValues(resource.attributes),
    droppedAttributesCount: 0,
  });
}

/**
 * Convert SDK InstrumentationScope to protobuf InstrumentationScope.
 */
function toProtoInstrumentationScope(
  scope: InstrumentationScope
): ProtoInstrumentationScope {
  return create(InstrumentationScopeSchema, {
    name: scope.name,
    version: scope.version ?? "",
    attributes: [],
    droppedAttributesCount: 0,
  });
}

// ============================================================================
// Trace Conversions (SDK -> Proto)
// ============================================================================

/**
 * Convert SDK SpanKind to protobuf Span_SpanKind.
 */
function toProtoSpanKind(kind: SpanKind): Span_SpanKind {
  switch (kind) {
    case SpanKind.INTERNAL:
      return Span_SpanKind.INTERNAL;
    case SpanKind.SERVER:
      return Span_SpanKind.SERVER;
    case SpanKind.CLIENT:
      return Span_SpanKind.CLIENT;
    case SpanKind.PRODUCER:
      return Span_SpanKind.PRODUCER;
    case SpanKind.CONSUMER:
      return Span_SpanKind.CONSUMER;
    default:
      return Span_SpanKind.UNSPECIFIED;
  }
}

/**
 * Convert SDK SpanStatusCode to protobuf Status_StatusCode.
 */
function toProtoStatusCode(code: SpanStatusCode): Status_StatusCode {
  switch (code) {
    case SpanStatusCode.UNSET:
      return Status_StatusCode.UNSET;
    case SpanStatusCode.OK:
      return Status_StatusCode.OK;
    case SpanStatusCode.ERROR:
      return Status_StatusCode.ERROR;
    default:
      return Status_StatusCode.UNSET;
  }
}

/**
 * Convert SDK SpanStatus to protobuf Status.
 */
function toProtoStatus(status: SpanStatus): Status {
  return create(StatusSchema, {
    code: toProtoStatusCode(status.code),
    message: status.message ?? "",
  });
}

/**
 * Convert SDK TimedEvent to protobuf Span_Event.
 */
function toProtoSpanEvent(event: TimedEvent): Span_Event {
  return create(Span_EventSchema, {
    timeUnixNano: hrTimeToNanos(event.time),
    name: event.name,
    attributes: toKeyValues(event.attributes),
    droppedAttributesCount: event.droppedAttributesCount ?? 0,
  });
}

/**
 * Convert SDK Link to protobuf Span_Link.
 */
function toProtoSpanLink(link: Link): Span_Link {
  return create(Span_LinkSchema, {
    traceId: hexToBytes(link.context.traceId),
    spanId: hexToBytes(link.context.spanId),
    traceState: link.context.traceState?.serialize() ?? "",
    attributes: toKeyValues(link.attributes),
    droppedAttributesCount: link.droppedAttributesCount ?? 0,
    flags: link.context.traceFlags,
  });
}

/**
 * Convert a ReadableSpan to a protobuf Span.
 */
function toProtoSpan(span: ReadableSpan): Span {
  const spanContext = span.spanContext();
  const parentSpanContext = span.parentSpanContext;

  return create(SpanSchema, {
    traceId: hexToBytes(spanContext.traceId),
    spanId: hexToBytes(spanContext.spanId),
    traceState: spanContext.traceState?.serialize() ?? "",
    parentSpanId: parentSpanContext
      ? hexToBytes(parentSpanContext.spanId)
      : new Uint8Array(),
    flags: spanContext.traceFlags,
    name: span.name,
    kind: toProtoSpanKind(span.kind),
    startTimeUnixNano: hrTimeToNanos(span.startTime),
    endTimeUnixNano: hrTimeToNanos(span.endTime),
    attributes: toKeyValues(span.attributes),
    droppedAttributesCount: span.droppedAttributesCount,
    events: span.events.map(toProtoSpanEvent),
    droppedEventsCount: span.droppedEventsCount,
    links: span.links.map(toProtoSpanLink),
    droppedLinksCount: span.droppedLinksCount,
    status: toProtoStatus(span.status),
  });
}

/**
 * Group spans by resource and instrumentation scope.
 */
function groupSpansByResourceAndScope(
  spans: ReadableSpan[]
): Map<Resource, Map<InstrumentationScope, ReadableSpan[]>> {
  const resourceMap = new Map<
    Resource,
    Map<InstrumentationScope, ReadableSpan[]>
  >();

  for (const span of spans) {
    let scopeMap = resourceMap.get(span.resource);
    if (!scopeMap) {
      scopeMap = new Map();
      resourceMap.set(span.resource, scopeMap);
    }

    let spanList = scopeMap.get(span.instrumentationScope);
    if (!spanList) {
      spanList = [];
      scopeMap.set(span.instrumentationScope, spanList);
    }

    spanList.push(span);
  }

  return resourceMap;
}

/**
 * Convert an array of ReadableSpans to protobuf TracesData.
 */
export function toTracesData(spans: ReadableSpan[]): TracesData {
  const resourceMap = groupSpansByResourceAndScope(spans);
  const resourceSpans: ResourceSpans[] = [];

  for (const [resource, scopeMap] of resourceMap) {
    const scopeSpans: ScopeSpans[] = [];

    for (const [scope, spanList] of scopeMap) {
      scopeSpans.push(
        create(ScopeSpansSchema, {
          scope: toProtoInstrumentationScope(scope),
          spans: spanList.map(toProtoSpan),
          schemaUrl: scope.schemaUrl ?? "",
        })
      );
    }

    resourceSpans.push(
      create(ResourceSpansSchema, {
        resource: toProtoResource(resource),
        scopeSpans,
        schemaUrl: resource.schemaUrl ?? "",
      })
    );
  }

  return create(TracesDataSchema, { resourceSpans });
}

// ============================================================================
// Reverse Conversions (Proto -> SDK)
// ============================================================================

/**
 * Convert nanoseconds bigint to HrTime.
 */
function nanosToHrTime(nanos: bigint): HrTime {
  const seconds = Number(nanos / 1_000_000_000n);
  const remainingNanos = Number(nanos % 1_000_000_000n);
  return [seconds, remainingNanos];
}

/**
 * Convert Uint8Array to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Convert protobuf AnyValue to SDK AttributeValue.
 */
function fromAnyValue(
  anyValue: AnyValue | undefined
): AttributeValue | undefined {
  if (!anyValue?.value) {
    return undefined;
  }

  switch (anyValue.value.case) {
    case "stringValue":
      return anyValue.value.value;
    case "boolValue":
      return anyValue.value.value;
    case "intValue":
      return Number(anyValue.value.value);
    case "doubleValue":
      return anyValue.value.value;
    case "arrayValue": {
      const values: (string | number | boolean)[] = [];
      for (const item of anyValue.value.value.values) {
        const val = fromAnyValue(item);
        if (val !== undefined && !Array.isArray(val)) {
          values.push(val);
        }
      }
      return values as AttributeValue;
    }
    case "bytesValue":
      return bytesToHex(anyValue.value.value);
    default:
      return undefined;
  }
}

/**
 * Convert protobuf KeyValue array to SDK Attributes.
 */
function fromKeyValues(keyValues: KeyValue[]): Attributes {
  const result: Attributes = {};
  for (const kv of keyValues) {
    const value = fromAnyValue(kv.value);
    if (value !== undefined) {
      result[kv.key] = value;
    }
  }
  return result;
}

/**
 * Convert protobuf Resource to SDK Resource.
 */
function fromProtoResource(protoResource: ProtoResource | undefined): Resource {
  if (!protoResource) {
    return resourceFromAttributes({});
  }
  return resourceFromAttributes(fromKeyValues(protoResource.attributes));
}

/**
 * Convert protobuf InstrumentationScope to SDK InstrumentationScope.
 */
function fromProtoInstrumentationScope(
  scope: ProtoInstrumentationScope | undefined
): InstrumentationScope {
  return {
    name: scope?.name ?? "",
    version: scope?.version,
    schemaUrl: undefined,
  };
}

/**
 * Convert protobuf Span_SpanKind to SDK SpanKind.
 */
function fromProtoSpanKind(kind: Span_SpanKind): SpanKind {
  switch (kind) {
    case Span_SpanKind.INTERNAL:
      return SpanKind.INTERNAL;
    case Span_SpanKind.SERVER:
      return SpanKind.SERVER;
    case Span_SpanKind.CLIENT:
      return SpanKind.CLIENT;
    case Span_SpanKind.PRODUCER:
      return SpanKind.PRODUCER;
    case Span_SpanKind.CONSUMER:
      return SpanKind.CONSUMER;
    default:
      return SpanKind.INTERNAL;
  }
}

/**
 * Convert protobuf Status_StatusCode to SDK SpanStatusCode.
 */
function fromProtoStatusCode(code: Status_StatusCode): SpanStatusCode {
  switch (code) {
    case Status_StatusCode.OK:
      return SpanStatusCode.OK;
    case Status_StatusCode.ERROR:
      return SpanStatusCode.ERROR;
    default:
      return SpanStatusCode.UNSET;
  }
}

/**
 * Convert protobuf Status to SDK SpanStatus.
 */
function fromProtoStatus(status: Status | undefined): SpanStatus {
  return {
    code: status ? fromProtoStatusCode(status.code) : SpanStatusCode.UNSET,
    message: status?.message,
  };
}

/**
 * Convert protobuf Span_Event to SDK TimedEvent.
 */
function fromProtoSpanEvent(event: Span_Event): TimedEvent {
  return {
    time: nanosToHrTime(event.timeUnixNano),
    name: event.name,
    attributes: fromKeyValues(event.attributes),
    droppedAttributesCount: event.droppedAttributesCount,
  };
}

/**
 * Convert protobuf Span_Link to SDK Link.
 */
function fromProtoSpanLink(link: Span_Link): Link {
  return {
    context: {
      traceId: bytesToHex(link.traceId),
      spanId: bytesToHex(link.spanId),
      traceFlags: link.flags,
      isRemote: true,
    },
    attributes: fromKeyValues(link.attributes),
    droppedAttributesCount: link.droppedAttributesCount,
  };
}

/**
 * Convert a protobuf Span to a ReadableSpan.
 */
function fromProtoSpan(
  span: Span,
  resource: Resource,
  instrumentationScope: InstrumentationScope
): ReadableSpan {
  const traceId = bytesToHex(span.traceId);
  const spanId = bytesToHex(span.spanId);
  const parentSpanId =
    span.parentSpanId.length > 0 ? bytesToHex(span.parentSpanId) : undefined;

  const startTime = nanosToHrTime(span.startTimeUnixNano);
  const endTime = nanosToHrTime(span.endTimeUnixNano);

  // Calculate duration
  const durationNanos = span.endTimeUnixNano - span.startTimeUnixNano;
  const duration = nanosToHrTime(durationNanos);

  return {
    name: span.name,
    kind: fromProtoSpanKind(span.kind),
    spanContext: () => ({
      traceId,
      spanId,
      traceFlags: span.flags,
      isRemote: false,
    }),
    parentSpanContext: parentSpanId
      ? {
          traceId,
          spanId: parentSpanId,
          traceFlags: span.flags,
          isRemote: true,
        }
      : undefined,
    startTime,
    endTime,
    status: fromProtoStatus(span.status),
    attributes: fromKeyValues(span.attributes),
    links: span.links.map(fromProtoSpanLink),
    events: span.events.map(fromProtoSpanEvent),
    duration,
    ended: true,
    resource,
    instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * Convert protobuf TracesData to an array of ReadableSpans.
 */
export function fromTracesData(tracesData: TracesData): ReadableSpan[] {
  const spans: ReadableSpan[] = [];

  for (const resourceSpans of tracesData.resourceSpans) {
    const resource = fromProtoResource(resourceSpans.resource);

    for (const scopeSpans of resourceSpans.scopeSpans) {
      const instrumentationScope = fromProtoInstrumentationScope(
        scopeSpans.scope
      );

      for (const span of scopeSpans.spans) {
        spans.push(fromProtoSpan(span, resource, instrumentationScope));
      }
    }
  }

  return spans;
}
