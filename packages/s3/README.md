# @smapped-traces/s3

S3-compatible source map store for [smapped-traces](../../README.md). Works with AWS S3, Google Cloud Storage, and Cloudflare R2.

## Installation

```bash
npm install @smapped-traces/s3 @aws-sdk/client-s3 smapped-traces
```

`@aws-sdk/client-s3` and `smapped-traces` are peer dependencies.

## Usage

### AWS S3

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({ region: "us-east-1" }),
  bucket: "my-sourcemaps",
  prefix: "sourcemaps/",
});
```

### Cloudflare R2

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({
    region: "auto",
    endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  }),
  bucket: "my-sourcemaps",
});
```

### Google Cloud Storage

GCS provides an [S3-compatible endpoint](https://cloud.google.com/storage/docs/interoperability):

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({
    region: "auto",
    endpoint: "https://storage.googleapis.com",
    credentials: {
      accessKeyId: process.env.GCS_HMAC_ACCESS_ID,
      secretAccessKey: process.env.GCS_HMAC_SECRET,
    },
  }),
  bucket: "my-sourcemaps",
});
```

## With `withSourceMaps()` (Build Time)

Upload source maps to S3 during the Next.js build:

```ts
// next.config.mjs
import { S3Client } from "@aws-sdk/client-s3";
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({ region: "us-east-1" }),
  bucket: "my-sourcemaps",
  prefix: "sourcemaps/",
});

export default withSourceMaps({ /* your config */ }, { store: () => store });
```

## With `createTracesHandler()` (Runtime)

Resolve source maps from S3 at request time:

```ts
// app/api/sourcemaps/route.ts
import { S3Client } from "@aws-sdk/client-s3";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { createTracesHandler } from "smapped-traces/route";
import { createS3Store } from "@smapped-traces/s3";

const store = createS3Store({
  client: new S3Client({ region: "us-east-1" }),
  bucket: "my-sourcemaps",
  prefix: "sourcemaps/",
});

export const POST = createTracesHandler({
  exporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  store,
});
```

## API

### `createS3Store(options: S3StoreOptions): SourceMapStore`

Returns a `SourceMapStore` that reads and writes source maps as objects in an S3-compatible bucket. Objects are stored as JSON with the debug ID as the key (optionally prefixed).

### `S3StoreOptions`

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `client` | `S3Client` | Yes | Pre-configured S3 client from `@aws-sdk/client-s3`. |
| `bucket` | `string` | Yes | Bucket name. |
| `prefix` | `string` | No | Key prefix prepended to all object keys (e.g. `"sourcemaps/"`). Defaults to `""`. |

## License

Apache-2.0
