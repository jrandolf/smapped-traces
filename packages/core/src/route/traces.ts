import { fromBinary } from "@bufbuild/protobuf";
import type {
  ReadableSpan,
  SpanExporter,
  TimedEvent,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_EXCEPTION_STACKTRACE } from "@opentelemetry/semantic-conventions";
import { fromTracesData } from "../convert.js";
import { TracesDataSchema } from "../generated/opentelemetry/proto/trace/v1/trace_pb.js";
import type { SourceMapStore } from "../store/types.js";
import {
  createSourceMapResolver,
  type SourceMapResolver,
} from "./source-map-resolver.js";

/**
 * Options for creating a traces handler.
 */
export interface TracesHandlerOptions {
  /** The span exporter to forward resolved traces to. */
  exporter: SpanExporter;
  /** Source map storage backend. If omitted, traces are forwarded without resolution. */
  store?: SourceMapStore;
}

/**
 * Resolves an exception event's stack trace using source maps in-place.
 */
async function resolveExceptionEvent(
  event: TimedEvent,
  sourceMapResolver: SourceMapResolver
): Promise<void> {
  if (event.name !== "exception") {
    return;
  }

  const stacktrace = event.attributes?.[ATTR_EXCEPTION_STACKTRACE];
  const debugIds = event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`];

  if (typeof stacktrace !== "string") {
    return;
  }

  if (!Array.isArray(debugIds) || debugIds.length === 0) {
    return;
  }

  const validDebugIds = debugIds.filter(
    (id): id is string => typeof id === "string"
  );
  if (validDebugIds.length === 0) {
    return;
  }

  try {
    const resolvedStack = await sourceMapResolver.resolveStackTrace(
      stacktrace,
      validDebugIds
    );

    const attrs = event.attributes as Record<string, unknown>;
    attrs[ATTR_EXCEPTION_STACKTRACE] = resolvedStack;
    attrs[`${ATTR_EXCEPTION_STACKTRACE}.original`] = stacktrace;
  } catch {
    // On resolution failure, keep original stack trace
  }
}

/**
 * Resolves exception stack traces in all spans using source maps in-place.
 */
async function resolveExceptionStackTraces(
  spans: ReadableSpan[],
  sourceMapResolver: SourceMapResolver
): Promise<void> {
  await Promise.all(
    spans.map(async (span) => {
      const hasExceptionWithDebugIds = span.events.some(
        (event) =>
          event.name === "exception" &&
          Array.isArray(
            event.attributes?.[`${ATTR_EXCEPTION_STACKTRACE}.debug_ids`]
          )
      );

      if (!hasExceptionWithDebugIds) {
        return;
      }

      await Promise.all(
        span.events.map((event) =>
          resolveExceptionEvent(event, sourceMapResolver)
        )
      );
    })
  );
}

/**
 * Creates a request handler that receives OTLP/protobuf traces, resolves
 * exception stack traces using source maps, and forwards to the provided
 * exporter.
 *
 * @example
 * ```ts
 * // Next.js: app/api/sourcemaps/route.ts
 * import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
 * import { createTracesHandler } from 'smapped-traces/route'
 * import { createSqliteStore } from 'smapped-traces/store'
 *
 * export const POST = createTracesHandler({
 *   exporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
 *   store: createSqliteStore('.next/sourcemaps.db'),
 * })
 * ```
 *
 * @example
 * ```ts
 * // Standalone server with remote store
 * import { createTracesHandler } from 'smapped-traces/route'
 * import { createHttpStore } from 'smapped-traces/store'
 * import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
 *
 * const handler = createTracesHandler({
 *   exporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
 *   store: createHttpStore('https://sourcemaps.internal'),
 * })
 *
 * Deno.serve({ port: 8080 }, handler)
 * ```
 */
export function createTracesHandler(options: TracesHandlerOptions) {
  const { exporter, store } = options;

  let resolver: SourceMapResolver | null = null;

  function getResolver(): SourceMapResolver | null {
    if (!store) {
      return null;
    }
    if (!resolver) {
      resolver = createSourceMapResolver({ store });
    }
    return resolver;
  }

  return async (request: Request): Promise<Response> => {
    const body = await request.bytes();
    const spans = fromTracesData(fromBinary(TracesDataSchema, body));

    const sourceMapResolver = getResolver();
    if (sourceMapResolver) {
      await resolveExceptionStackTraces(spans, sourceMapResolver);
    }

    return new Promise((resolve, reject) => {
      exporter.export(spans, (result) => {
        if (result.error) {
          reject(result.error);
        } else {
          resolve(new Response(null, { status: 200 }));
        }
      });
    });
  };
}
