# sourcemap-otel

Source map resolution for OpenTelemetry errors. Automatically resolves minified stack traces back to original source locations using debug IDs.

## How It Works

1. **Build time**: Source maps are collected and stored (locally or in a remote store)
2. **Client side**: Exception stack traces are enriched with debug IDs from bundler-injected globals (`_debugIds` or `__DEBUG_IDS__`)
3. **Server side**: A request handler resolves minified stack traces using the stored source maps before forwarding to your OTEL collector

## Packages

| Package | Description |
| --- | --- |
| [`smapped-traces`](./packages/core) | Core library — client exporter, route handler, source map resolver, and store abstraction |
| [`@smapped-traces/nextjs`](./packages/nextjs) | Next.js plugin — build-time source map collection via `withSourceMaps()` |
| [`@smapped-traces/sqlite`](./packages/sqlite) | SQLite-backed source map store for local and single-server deployments |
| [`@smapped-traces/s3`](./packages/s3) | S3-compatible source map store (AWS S3, GCS, Cloudflare R2) |

## Quick Start (Next.js)

### 1. Install

```bash
npm install smapped-traces @smapped-traces/nextjs @smapped-traces/sqlite
```

### 2. Configure Next.js

```ts
// next.config.mjs
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createSqliteStore } from "@smapped-traces/sqlite";
import { join } from "node:path";

export default withSourceMaps(
  {
    // your config
  },
  {
    store: (distDir) => createSqliteStore(join(distDir, "sourcemaps.db")),
  }
);
```

### 3. Set Up the Client Exporter

```ts
// instrumentation-client.ts
import { SourceMappedSpanExporter } from "smapped-traces/client";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const exporter = new SourceMappedSpanExporter("/api/sourcemaps");
const provider = new WebTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();
```

### 4. Create the Route Handler

```ts
// app/api/sourcemaps/route.ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createTracesHandler } from "smapped-traces/route";
import { createSqliteStore } from "@smapped-traces/sqlite";
import { join } from "node:path";

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";

export const POST = createTracesHandler({
  exporter: new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` }),
  store: createSqliteStore(join(process.cwd(), ".next/sourcemaps.db")),
});
```

## Storage

Source maps are accessed through the `SourceMapStore` interface. Built-in stores:

| Store | Package | Description |
| --- | --- | --- |
| `createSqliteStore(dbPath)` | `@smapped-traces/sqlite` | Local SQLite database |
| `createHttpStore(url)` | `smapped-traces/store` | HTTP client for a remote store handler |
| `createS3Store(options)` | `@smapped-traces/s3` | S3-compatible bucket (AWS, GCS, R2) |

### Remote Store

Deploy a storage service and point your build + handler at it:

```ts
// storage-service.ts — deploy separately
import { createStoreHandler } from "smapped-traces/store";
import { createSqliteStore } from "@smapped-traces/sqlite";

const store = createSqliteStore("./sourcemaps.db");
Bun.serve({ port: 8081, fetch: createStoreHandler(store) });
```

```ts
// next.config.mjs — build uploads to the remote store
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createHttpStore } from "smapped-traces/store";

export default withSourceMaps(
  { /* your config */ },
  { store: () => createHttpStore("https://sourcemaps.internal") }
);
```

```ts
// traces-handler.ts — resolves from the same remote store
import { createTracesHandler } from "smapped-traces/route";
import { createHttpStore } from "smapped-traces/store";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const handler = createTracesHandler({
  exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  store: createHttpStore("https://sourcemaps.internal"),
});
```

### S3 Store

```bash
npm install @smapped-traces/s3 @aws-sdk/client-s3
```

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({ region: "us-east-1" }),
  bucket: "my-sourcemaps",
  prefix: "sourcemaps/",
});

// Use with withSourceMaps(), createTracesHandler(), or createSourceMapResolver()
```

## Standalone Server

The handler uses standard Web `Request`/`Response`, so it works outside Next.js:

```ts
// Bun
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createTracesHandler } from "smapped-traces/route";
import { createSqliteStore } from "@smapped-traces/sqlite";

const handler = createTracesHandler({
  exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  store: createSqliteStore("./sourcemaps.db"),
});

Bun.serve({ port: 8080, fetch: handler });
```

## Exports

### `smapped-traces`

| Path | Description |
| --- | --- |
| `smapped-traces/client` | `SourceMappedSpanExporter` — Client-side span exporter with debug ID enrichment |
| `smapped-traces/route` | `createTracesHandler()` — Request handler with source map resolution |
| `smapped-traces/resolve` | `createSourceMapResolver()` — Standalone source map resolver |
| `smapped-traces/store` | `SourceMapStore`, `createHttpStore()`, `createStoreHandler()` |

### `@smapped-traces/nextjs`

| Path | Description |
| --- | --- |
| `@smapped-traces/nextjs` | `withSourceMaps()` — Next.js config helper for build-time source map collection |

### `@smapped-traces/sqlite`

| Path | Description |
| --- | --- |
| `@smapped-traces/sqlite` | `createSqliteStore()` — SQLite-backed store |

### `@smapped-traces/s3`

| Path | Description |
| --- | --- |
| `@smapped-traces/s3` | `createS3Store()` — S3-compatible bucket store |

## Debug ID Support

The client exporter reads debug IDs from two global variables:

| Global | Bundler | Format |
| --- | --- | --- |
| `globalThis._debugIds` | Turbopack | Stack trace keys → debug ID UUIDs |
| `globalThis.__DEBUG_IDS__` | TC39 spec / webpack | URL keys → debug ID UUIDs |

Both are checked and merged automatically.

## Requirements

- Next.js 16+ (only for `@smapped-traces/nextjs` — uses `runAfterProductionCompile` hook)
- OpenTelemetry SDK v2+

## License

Apache-2.0
