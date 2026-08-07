# @smapped-traces/vite

Vite plugin and post-build collector for build-time source map collection.

## Installation

```bash
npm install smapped-traces @smapped-traces/vite @smapped-traces/sqlite
```

## Usage

### 1. Configure the build

Add the `sourceMaps()` plugin so production builds emit hidden, debug-ID-stamped source maps:

```ts
// vite.config.ts
import { sourceMaps } from "@smapped-traces/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sourceMaps()],
});
```

### 2. Collect after the build

Run `collectSourceMaps()` after the full build pipeline has produced its final output directory. Collection is deliberately not a build hook: framework plugins such as SvelteKit run their adapters inside the build's own lifecycle, so a hook cannot observe the final output.

```ts
// scripts/collect-sourcemaps.mjs — run as `vite build && node scripts/collect-sourcemaps.mjs`
import { collectSourceMaps } from "@smapped-traces/vite";
import { createSqliteStore } from "@smapped-traces/sqlite";
import { join } from "node:path";

await collectSourceMaps({
  dir: "build",
  store: (dir) => createSqliteStore(join(dir, "sourcemaps.db")),
});
```

Every `.map` file under `dir` is deleted afterwards so no source maps deploy.

### SvelteKit

`adapter-node` re-bundles the server with its own bundler pass that does not preserve debug IDs, so restrict storage to the client output. Server maps are still deleted:

```ts
await collectSourceMaps({
  dir: "build",
  include: "client/**/*.{,c,m}js.map",
  store: (dir) => createSqliteStore(join(dir, "sourcemaps.db")),
});
```

### Remote stores

Any [`SourceMapStore`](../core/src/store/types.ts) works — see the [root README](../../README.md):

```ts
import { createHttpStore } from "smapped-traces/store";

await collectSourceMaps({
  dir: "dist",
  store: () => createHttpStore("https://sourcemaps.internal"),
});
```

## Options

`collectSourceMaps(options)` accepts a `CollectSourceMapsOptions` object:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | `string` | Yes | Build output directory to sweep for `.map` files. |
| `store` | `(dir: string) => SourceMapStore \| Promise<SourceMapStore>` | Yes | Factory that creates a source map store. Called with `dir`. |
| `include` | `string \| string[]` | No | Glob pattern(s), relative to `dir`, selecting the maps to store. Defaults to every JavaScript source map (`**/*.{,c,m}js.map`). A selected map without a `debugId` is an error; maps outside the selection are deleted without being stored. |

It resolves to `{ stored, deleted }` counts.

## What it does

1. `sourceMaps()` sets `build.sourcemap = "hidden"` and `build.rolldownOptions.output.sourcemapDebugIds = true`
2. `collectSourceMaps()`:
   - Globs for all `.map` files in the build output, including dot directories
   - Parses each selected source map and extracts its `debugId`
   - Uploads it to the provided store via `store.put(debugId, content)`
   - Deletes every `.map` file from the build output so none are deployed
   - Fails if a selected map carries no `debugId`

## Requirements

- Vite 8+ (uses Rolldown's `sourcemapDebugIds` output option)

## License

Apache-2.0
