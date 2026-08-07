# @smapped-traces/vite

Vite plugin for build-time source map collection.

## Installation

```bash
npm install smapped-traces @smapped-traces/vite @smapped-traces/sqlite
```

## Usage

Add the `sourceMaps()` plugin. Production builds emit hidden, debug-ID-stamped source maps, and with the `collect` option the plugin stores them and deletes every `.map` file once the final build output exists:

```ts
// vite.config.ts
import { join } from "node:path";
import { createSqliteStore } from "@smapped-traces/sqlite";
import { sourceMaps } from "@smapped-traces/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sourceMaps({
      collect: {
        store: (dir) => createSqliteStore(join(dir, "sourcemaps.db")),
      },
    }),
  ],
});
```

### SvelteKit

Collection runs via a post-ordered sequential `closeBundle` hook, after SvelteKit's adapter assembles its deploy directory in the same phase (the client compile pass, which ends before the adapter runs, is skipped). The adapter's deploy directory is not Vite's `outDir`, so set `dir` — and since `adapter-node` re-bundles the server without preserving debug IDs, restrict storage to the client output. Server maps are still deleted:

```ts
sourceMaps({
  collect: {
    dir: "build",
    include: "client/**/*.{,c,m}js.map",
    store: (dir) => createSqliteStore(join(dir, "sourcemaps.db")),
  },
});
```

### Remote stores

Any [`SourceMapStore`](../core/src/store/types.ts) works — see the [root README](../../README.md):

```ts
import { createHttpStore } from "smapped-traces/store";

sourceMaps({
  collect: {
    store: () => createHttpStore("https://sourcemaps.internal"),
  },
});
```

### Collecting outside the build

When the final output is produced outside the Vite build entirely — a pipeline the plugin cannot order against — leave `collect` unset and run the sweep yourself after that pipeline completes:

```ts
import { collectSourceMaps } from "@smapped-traces/vite";

await collectSourceMaps({
  dir: "dist",
  store: (dir) => createSqliteStore(join(dir, "sourcemaps.db")),
});
```

It resolves to `{ stored, deleted }` counts.

## Options

`sourceMaps(options?)` accepts a `SourceMapsOptions` object whose `collect` field enables the automatic sweep. `collect` and `collectSourceMaps(options)` share `CollectSourceMapsOptions`:

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `dir` | `string` | In `collectSourceMaps` | Build output directory to sweep for `.map` files. In `collect` it defaults to the resolved `build.outDir`; a framework whose adapter assembles a separate deploy directory must set it, and relative paths resolve against the project root. |
| `store` | `(dir: string) => SourceMapStore \| Promise<SourceMapStore>` | Yes | Factory that creates a source map store. Called with `dir`. |
| `include` | `string \| string[]` | No | Glob pattern(s), relative to `dir`, selecting the maps to store. Defaults to every JavaScript source map (`**/*.{,c,m}js.map`). A selected map without a `debugId` is an error; maps outside the selection are deleted without being stored. |

## What it does

1. Sets `build.sourcemap = "hidden"` and `build.rolldownOptions.output.sourcemapDebugIds = true`
2. After the final build output exists (or when `collectSourceMaps()` is called):
   - Globs for all `.map` files in the build output, including dot directories
   - Parses each selected source map and extracts its `debugId`
   - Uploads it to the provided store via `store.put(debugId, content)`
   - Deletes every `.map` file from the build output so none are deployed
   - Fails if a selected map carries no `debugId`

## Requirements

- Vite 8+ (uses Rolldown's `sourcemapDebugIds` output option)

## License

Apache-2.0
