import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import FastGlob from "fast-glob";
import type { SourceMapStore } from "smapped-traces/store";
import type { Plugin } from "vite";

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
 * Options for {@link sourceMaps}.
 */
export interface SourceMapsOptions {
  /**
   * When set, runs {@link collectSourceMaps} automatically once the final
   * build output exists, via a post-ordered sequential `closeBundle` hook.
   * That ordering runs after SvelteKit's adapter, which assembles its deploy
   * directory in the same phase; for the SvelteKit client compile pass —
   * which ends before the adapter runs — collection is skipped.
   *
   * `dir` defaults to the resolved `build.outDir`. A framework whose adapter
   * assembles a separate deploy directory must set `dir` to that directory
   * (for example SvelteKit `adapter-node`'s `"build"`); relative paths
   * resolve against the project root.
   */
  collect?: Omit<CollectSourceMapsOptions, "dir"> & { dir?: string };
}

/**
 * Vite plugin that configures production builds for source map collection.
 *
 * Emits hidden source maps (no `sourceMappingURL` comment in the deployed
 * chunks) and stamps every chunk and map with a debug ID so
 * {@link collectSourceMaps} can key the store. With
 * {@link SourceMapsOptions.collect | collect} set, the sweep also runs
 * automatically at the end of the build.
 */
export function sourceMaps(options: SourceMapsOptions = {}): Plugin {
  const { collect } = options;
  let dir: string;
  let skip = false;
  let info: (message: string) => void;

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
    configResolved(config) {
      dir = path.resolve(config.root, collect?.dir ?? config.build.outDir);
      // SvelteKit builds the client, then the server, and runs the adapter at
      // the end of the server compile pass; only that pass sees the deploy
      // directory.
      skip =
        config.plugins.some(
          (plugin) => plugin.name === "vite-plugin-sveltekit-compile"
        ) && !config.build.ssr;
      info = (message) => config.logger.info(message);
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (collect === undefined || skip) {
          return;
        }
        const { deleted, stored } = await collectSourceMaps({
          ...collect,
          dir,
        });
        info(
          `smapped-traces: stored ${stored} source maps, deleted ${deleted} map files`
        );
      },
    },
  };
}

/**
 * Collects debug-ID-keyed source maps from a build output directory into a
 * store, then deletes every `.map` file so no source maps deploy.
 *
 * {@link sourceMaps} with the `collect` option runs this automatically. Call
 * it directly when the build pipeline produces its final output outside the
 * Vite build — for example a framework adapter the plugin does not know how
 * to order against — and run it after that pipeline completes.
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
          const content = await readFile(
            path.join(options.dir, relative),
            "utf8"
          );
          const { debugId } = JSON.parse(content) as { debugId?: unknown };
          if (typeof debugId === "string" && debugId.length > 0) {
            await store.put(debugId, content);
            stored += 1;
          } else {
            missingDebugIds.push(relative);
          }
        })
    );
    await Promise.all(
      maps.map((relative) => rm(path.join(options.dir, relative)))
    );
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
