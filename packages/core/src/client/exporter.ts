/**
 * Client-side span exporter that enriches exception events with debug IDs
 * and sends traces to a server endpoint via fetch/sendBeacon.
 */

import { toBinary } from "@bufbuild/protobuf";
import { context, diag } from "@opentelemetry/api";
import {
  type ExportResult,
  ExportResultCode,
  suppressTracing,
} from "@opentelemetry/core";
import type {
  ReadableSpan,
  SpanExporter,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_EXCEPTION_STACKTRACE } from "@opentelemetry/semantic-conventions";
import { toTracesData } from "../convert.js";
import { TracesDataSchema } from "../generated/opentelemetry/proto/trace/v1/trace_pb.js";
import { extractDebugIdsFromStack } from "./debug-ids.js";

/**
 * Availability state for the exporter:
 * - 0: Disabled (server returned 204)
 * - 1: Initial state, uses fetch
 * - 2: Active, uses sendBeacon
 */
type AvailabilityState = 0 | 1 | 2;

/**
 * A span exporter that enriches exception events with debug IDs for
 * server-side source map resolution, then sends traces as OTLP/protobuf
 * via fetch (with sendBeacon fallback for page unload reliability).
 *
 * @example
 * ```ts
 * import { SourceMapSpanExporter } from 'smapped-traces/client'
 * import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
 *
 * const exporter = new SourceMapSpanExporter('/api/sourcemaps')
 * const provider = new WebTracerProvider({
 *   spanProcessors: [new BatchSpanProcessor(exporter)],
 * })
 * provider.register()
 * ```
 */
export class SourceMappedSpanExporter implements SpanExporter {
  readonly #url: string;
  #available: AvailabilityState = 1;

  constructor(url: string) {
    this.#url = url;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    if (this.#available === 0) {
      diag.debug("Exporter is disabled, returning success");
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    this.#attachDebugIds(spans);
    const body = toBinary(TracesDataSchema, toTracesData(spans));

    if (this.#available === 2) {
      diag.debug("Exporter is using sendBeacon");
      const success = navigator.sendBeacon(this.#url, body);
      resultCallback({
        code: success ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
      });
      return;
    }

    (async () => {
      diag.debug("Exporter is using fetch");
      const response = await context.with(
        suppressTracing(context.active()),
        () => fetch(this.#url, { method: "POST", body })
      );
      if (response.ok) {
        this.#available = response.status === 204 ? 0 : 2;
        resultCallback({ code: ExportResultCode.SUCCESS });
        return;
      }
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(await response.text()),
      });
    })();
  }

  async forceFlush(): Promise<void> {
    // noop
  }

  async shutdown(): Promise<void> {
    // noop
  }

  /**
   * Attaches debug IDs to exception events in spans.
   */
  #attachDebugIds(spans: ReadableSpan[]): void {
    for (const span of spans) {
      for (const event of span.events) {
        this.#enrichExceptionEvent(event);
      }
    }
  }

  /**
   * Enriches an exception event with debug IDs extracted from its stack trace.
   */
  #enrichExceptionEvent(event: TimedEvent): void {
    if (event.name !== "exception") {
      return;
    }

    const stacktrace = event.attributes?.[ATTR_EXCEPTION_STACKTRACE];
    if (typeof stacktrace !== "string") {
      return;
    }

    const debugIds = extractDebugIdsFromStack(stacktrace);
    if (debugIds.length === 0) {
      return;
    }

    event.attributes = {
      ...event.attributes,
      [`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]: debugIds,
    };
  }
}
