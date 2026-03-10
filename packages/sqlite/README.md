# @smapped-traces/sqlite

SQLite-backed source map store for [smapped-traces](../../packages/core/README.md).

Suitable for local development, single-server deployments, and CI pipelines where source maps are collected and resolved on the same machine.

## Installation

```sh
npm install @smapped-traces/sqlite smapped-traces better-sqlite3
```

## Usage

### Build-time collection with Next.js

```ts
// next.config.ts
import { withSourceMaps } from "@smapped-traces/nextjs";
import { createSqliteStore } from "@smapped-traces/sqlite";

export default withSourceMaps(nextConfig, {
  store: (distDir) => createSqliteStore(`${distDir}/sourcemaps.db`),
});
```

### Runtime resolution in the traces handler

```ts
import { createTracesHandler } from "smapped-traces/route";
import { createSqliteStore } from "@smapped-traces/sqlite";

const store = createSqliteStore("./sourcemaps.db");

export const POST = createTracesHandler({ exporter, store });
```

### Serving as a remote store

```ts
import { createStoreHandler } from "smapped-traces/store";
import { createSqliteStore } from "@smapped-traces/sqlite";

const store = createSqliteStore("./sourcemaps.db");
const handler = createStoreHandler(store);

// Express, Hono, or any framework that accepts (Request) => Response
app.use("/sourcemaps", handler);
```

## API

### `createSqliteStore(dbPath)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `dbPath` | `string` | Path to the SQLite database file. Created on first write. |

Returns a `SourceMapStore`. The table is created lazily on the first `put`. Calling `close()` releases the database connection.

## License

Apache-2.0
