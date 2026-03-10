# smapped-traces

Source map resolution for OpenTelemetry errors. Resolves minified stack traces back to original source locations using debug IDs.

## Installation

```bash
npm install smapped-traces
```

## Entry Points

| Path | Exports | Description |
| --- | --- | --- |
| `smapped-traces/client` | `SourceMappedSpanExporter`, `extractDebugIdsFromStack`, `getDebugIdsByUrl` | Client-side span exporter with debug ID enrichment |
| `smapped-traces/route` | `createTracesHandler`, `createSourceMapResolver` | Request handler that resolves traces and forwards to your OTEL collector |
| `smapped-traces/resolve` | `createSourceMapResolver`, `formatStackTrace` | Standalone source map resolution (no request handling) |
| `smapped-traces/store` | `SourceMapStore`, `createSqliteStore`, `createHttpStore`, `createStoreHandler` | Source map storage backends and HTTP handler |

## Usage

### Client Exporter

`SourceMappedSpanExporter` is a `SpanExporter` that enriches exception events with debug IDs extracted from bundler-injected globals (`_debugIds` from Turbopack, `__DEBUG_IDS__` from the TC39 spec / webpack), then sends traces as OTLP/protobuf via `fetch` (with `sendBeacon` fallback on page unload).

```ts
import { SourceMappedSpanExporter } from "smapped-traces/client";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const exporter = new SourceMappedSpanExporter("/api/sourcemaps");
const provider = new WebTracerProvider({
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();
```

### Traces Handler

`createTracesHandler` returns a `(Request) => Promise<Response>` handler that accepts OTLP/protobuf traces, resolves exception stack traces using source maps from the provided store, and forwards the resolved spans to your exporter.

```ts
// Next.js: app/api/sourcemaps/route.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createTracesHandler } from "smapped-traces/route";
import { createSqliteStore } from "smapped-traces/store";

export const POST = createTracesHandler({
  exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  store: createSqliteStore(".next/sourcemaps.db"),
});
```

The handler uses standard Web `Request`/`Response`, so it works with any runtime:

```ts
// Bun
Bun.serve({ port: 8080, fetch: handler });

// Deno
Deno.serve({ port: 8080 }, handler);
```

### Source Map Resolver

`createSourceMapResolver` provides standalone stack trace resolution without a request handler. Useful when you need to resolve traces outside the HTTP request flow (e.g. in a queue consumer or background job).

```ts
import { createSourceMapResolver } from "smapped-traces/resolve";
import { createSqliteStore } from "smapped-traces/store";

const resolver = createSourceMapResolver({
  store: createSqliteStore("./sourcemaps.db"),
  maxCacheSize: 100, // LRU cache for parsed source maps (default: 50)
});

const resolved = await resolver.resolveStackTrace(minifiedStack, debugIds);

// Clean up when done
resolver.close();
```

### Store

Source maps are stored and retrieved through the `SourceMapStore` interface. Two built-in implementations are provided.

#### SQLite Store

Local storage backed by a SQLite database. The database and table are created on first write.

```ts
import { createSqliteStore } from "smapped-traces/store";

const store = createSqliteStore("./sourcemaps.db");
```

#### HTTP Store

Communicates with a remote store handler over HTTP. Pair with `createStoreHandler` on the server side.

```ts
import { createHttpStore } from "smapped-traces/store";

const store = createHttpStore("https://sourcemaps.internal");
```

#### Store Handler

`createStoreHandler` exposes a `SourceMapStore` as a REST API (`GET /:debugId`, `PUT /:debugId`). Deploy as a standalone service to share source maps across build and runtime environments.

```ts
import { createSqliteStore, createStoreHandler } from "smapped-traces/store";

const store = createSqliteStore("./sourcemaps.db");
Bun.serve({ port: 8081, fetch: createStoreHandler(store) });
```

## SourceMapStore Interface

Implement this interface to provide a custom storage backend:

```ts
interface SourceMapStore {
  /** Retrieves a source map by debug ID. Returns null if not found. */
  get(debugId: string): Promise<string | null>;

  /** Stores a source map JSON string by debug ID. */
  put(debugId: string, content: string): Promise<void>;

  /** Releases resources held by the store (optional). */
  close?(): void;
}
```

## Requirements

- OpenTelemetry SDK v2+ (`@opentelemetry/sdk-trace-base ^2.0.0`, `@opentelemetry/core ^2.0.0`)
- `@opentelemetry/api ^1.9.0`

## License

Apache-2.0
