import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import FastGlob from "fast-glob";
import type { SourceMapStore } from "smapped-traces/store";
import type { Plugin } from "vite";

/**
 * Vite plugin that configures production builds for source map collection.
 *
 * Emits hidden source maps (no `sourceMappingURL` comment in the deployed
 * chunks) and stamps every chunk and map with a debug ID so
 * {@link collectSourceMaps} can key the store.
 */
export function sourceMaps(): Plugin {
  return {
    name: "smapped-traces:source-maps",
    apply: "build",
    config() {
      return {
        build: {
          sourcemap: "hidden",
          rolldownOptions: {
            output: {
              sourcemapDebugIds: true,
            },
          },
        },
      };
    },
  };
}

/**
 * Options for {@link collectSourceMaps}.
 */
export interface CollectSourceMapsOptions {
  /**
   * Build output directory to sweep for `.map` files.
   */
  dir: string;
  /**
   * Glob pattern(s), relative to `dir`, selecting the source maps to store.
   * Defaults to every JavaScript source map. A selected map without a
   * `debugId` is an error; maps outside the selection are deleted without
   * being stored.
   *
   * Frameworks that post-process the Vite output can re-bundle parts of it
   * without preserving debug IDs (for example SvelteKit's `adapter-node`
   * server bundle), so narrow the selection to the output that still carries
   * them, such as `"client/**\/*.{,c,m}js.map"`.
   */
  include?: string | string[];
  /**
   * Factory that creates a source map store. Called with `dir` so the store
   * can be placed relative to the build output.
   *
   * @example
   * ```ts
   * // Local SQLite
   * store: (dir) => createSqliteStore(join(dir, "sourcemaps.db"))
   *
   * // Remote
   * store: () => createHttpStore("https://sourcemaps.internal")
   * ```
   */
  store: (dir: string) => SourceMapStore | Promise<SourceMapStore>;
}

/**
 * Result of {@link collectSourceMaps}.
 */
export interface CollectSourceMapsResult {
  /**
   * Number of `.map` files deleted from the build output.
   */
  deleted: number;
  /**
   * Number of source maps stored by debug ID.
   */
  stored: number;
}

/**
 * Collects debug-ID-keyed source maps from a build output directory into a
 * store, then deletes every `.map` file so no source maps deploy.
 *
 * Run this after the full build pipeline — including any framework
 * post-processing such as a SvelteKit adapter — has produced its final output
 * directory. Collection is deliberately not a build hook: framework plugins
 * run their adapters inside the build's own lifecycle, so a hook cannot
 * observe the final output.
 */
export async function collectSourceMaps(
  options: CollectSourceMapsOptions
): Promise<CollectSourceMapsResult> {
  const maps = await FastGlob("**/*.map", { cwd: options.dir, dot: true });
  const included = new Set(
    await FastGlob(options.include ?? "**/*.{,c,m}js.map", {
      cwd: options.dir,
      dot: true,
    })
  );

  const missingDebugIds: string[] = [];
  let stored = 0;

  const store = await options.store(options.dir);
  try {
    await Promise.all(
      maps
        .filter((relative) => included.has(relative))
        .map(async (relative) => {
          const content = await readFile(join(options.dir, relative), "utf8");
          const { debugId } = JSON.parse(content) as { debugId?: unknown };
          if (typeof debugId === "string" && debugId.length > 0) {
            await store.put(debugId, content);
            stored += 1;
          } else {
            missingDebugIds.push(relative);
          }
        })
    );
    await Promise.all(maps.map((relative) => rm(join(options.dir, relative))));
  } finally {
    store.close?.();
  }

  if (missingDebugIds.length > 0) {
    throw new Error(
      `source maps missing debugId (sourceMaps plugin not applied?):\n  ${missingDebugIds.sort().join("\n  ")}`
    );
  }

  return { deleted: maps.length, stored };
}
