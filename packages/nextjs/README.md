# @smapped-traces/nextjs

Next.js plugin for build-time source map collection and upload.

## Installation

```bash
npm install smapped-traces @smapped-traces/nextjs @smapped-traces/sqlite
```

## Usage

Wrap your Next.js config with `withSourceMaps()` and provide a `store` factory:

### Local SQLite store

```ts
// next.config.mjs
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createSqliteStore } from "@smapped-traces/sqlite";
import { join } from "node:path";

export default withSourceMaps(
  {
    // your Next.js config
  },
  {
    store: (distDir) => createSqliteStore(join(distDir, "sourcemaps.db")),
  }
);
```

### Remote HTTP store

Deploy a storage service separately (see the [root README](../../README.md) for details), then point the build at it:

```ts
// next.config.mjs
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createHttpStore } from "smapped-traces/store";

export default withSourceMaps(
  {
    // your Next.js config
  },
  {
    store: () => createHttpStore("https://sourcemaps.internal"),
  }
);
```

### S3 store

```bash
npm install @smapped-traces/s3 @aws-sdk/client-s3
```

```ts
// next.config.mjs
import { withSourceMaps } from "@smapped-traces/nextjs";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Store } from "@smapped-traces/s3";

export default withSourceMaps(
  {
    // your Next.js config
  },
  {
    store: () =>
      createS3Store({
        client: new S3Client({ region: "us-east-1" }),
        bucket: "my-sourcemaps",
        prefix: "sourcemaps/",
      }),
  }
);
```

## Options

`withSourceMaps(nextConfig, options)` accepts a `SourceMapOptions` object:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `store` | `(distDir: string) => SourceMapStore \| Promise<SourceMapStore>` | Yes | Factory that creates a source map store. Called during the post-build hook with the build output directory (e.g. `.next`). |
| `replaceTurbopackSourcePrefix` | `` `${string}://${string}` \| "" `` | No | URL prefix to replace the `turbopack:///[project]/` prefix in source map paths. For example, `"file:///"` rewrites `turbopack:///[project]/src/app.ts` to `file:///src/app.ts`. |

## What it does

Calling `withSourceMaps()` applies the following changes to your Next.js config:

1. Enables Turbopack debug IDs (`turbopack.debugIds = true`)
2. Enables production browser source maps (`productionBrowserSourceMaps = true`)
3. Registers a `runAfterProductionCompile` hook that:
   - Globs for all `.js.map`, `.mjs.map`, and `.cjs.map` files in the build output
   - Parses each source map and extracts its `debugId`
   - Optionally rewrites Turbopack source prefixes
   - Uploads the source map to the provided store via `store.put(debugId, content)`
   - Deletes the `.map` files from the build output so they are not deployed

Any existing `runAfterProductionCompile` hook is preserved and called after source map collection completes.

## Requirements

- Next.js 16+ (uses the `runAfterProductionCompile` compiler hook)

## License

Apache-2.0
