import type { NextConfig } from "next";
import type { SourceMapStore } from "smapped-traces/store";
import type { RawIndexMap, RawSourceMap } from "source-map";

/**
 * Options for source map configuration.
 */
export interface SourceMapOptions {
  /**
   * URL prefix to replace the Turbopack source prefix in source maps.
   *
   * When set, paths with the `turbopack:///[project]/` prefix are transformed
   * at build time. The value must be a valid URL that will replace the
   * Turbopack prefix.
   *
   * For example, if the source map contains `turbopack:///[project]/src/app.ts`:
   * - `"file:///"` results in `file:///src/app.ts`
   * - `"app:///"` results in `app:///src/app.ts`
   */
  replaceTurbopackSourcePrefix?: `${string}://${string}` | "";
  /**
   * Factory that creates a source map store. Called during the post-build hook
   * with the build output directory so the store can be placed relative to it.
   *
   * @param distDir The Next.js build output directory (e.g. ".next").
   *
   * @example
   * ```ts
   * // Local SQLite
   * store: (distDir) => createSqliteStore(join(distDir, "sourcemaps.db"))
   *
   * // Remote
   * store: () => createHttpStore("https://sourcemaps.internal")
   *
   * // S3
   * store: () => createS3Store({ client, bucket: "my-sourcemaps" })
   * ```
   */
  store: (distDir: string) => SourceMapStore | Promise<SourceMapStore>;
}

/**
 * Regex pattern for Turbopack project prefix.
 */
const TURBOPACK_PROJECT_PREFIX = /^turbopack:\/\/\/\[project\]\//;

/**
 * Source map with debug ID extension.
 */
type SourceMapWithDebugId = (RawSourceMap | RawIndexMap) & { debugId: string };

/**
 * Transforms source paths in a sources array in-place.
 */
function transformSources(
  sources: string[],
  replaceTurbopackSourcePrefix: string
): void {
  for (let i = 0; i < sources.length; i++) {
    sources[i] = sources[i].replace(TURBOPACK_PROJECT_PREFIX, "");
    if (replaceTurbopackSourcePrefix !== "") {
      sources[i] = new URL(sources[i], replaceTurbopackSourcePrefix).href;
    }
  }
}

/**
 * Transforms source paths in a source map in-place, replacing Turbopack prefixes.
 */
function transformSourceMapPaths(
  sourceMap: SourceMapWithDebugId,
  replaceTurbopackSourcePrefix: string
): void {
  if ("sources" in sourceMap) {
    transformSources(sourceMap.sources, replaceTurbopackSourcePrefix);
  }
  if ("sections" in sourceMap) {
    for (const section of sourceMap.sections) {
      transformSources(section.map.sources, replaceTurbopackSourcePrefix);
    }
  }
}

export function withSourceMaps(
  nextConfig: NextConfig,
  options: SourceMapOptions
): NextConfig {
  nextConfig.serverExternalPackages ??= [];
  nextConfig.serverExternalPackages.push("source-map");

  nextConfig.turbopack ??= {};
  nextConfig.turbopack.debugIds = true;

  nextConfig.productionBrowserSourceMaps = true;

  nextConfig.compiler ??= {};
  const runAfterProductionCompile =
    nextConfig.compiler.runAfterProductionCompile;
  nextConfig.compiler.runAfterProductionCompile = async (args) => {
    const { join } = await import("node:path");
    const { readFile, rm } = await import("node:fs/promises");
    const { default: FastGlob } = await import("fast-glob");

    const store = await options.store(args.distDir);

    const promises: Promise<void>[] = [];
    for await (const mapFile of FastGlob.globStream(
      join(args.distDir, "**", "*.{m,c,}js.map")
    )) {
      promises.push(
        readFile(mapFile, "utf8").then(async (content) => {
          try {
            const sourceMap = JSON.parse(content) as SourceMapWithDebugId;
            if (typeof sourceMap.debugId !== "string") {
              return;
            }

            if (options.replaceTurbopackSourcePrefix !== undefined) {
              transformSourceMapPaths(
                sourceMap,
                options.replaceTurbopackSourcePrefix
              );
            }

            await store.put(sourceMap.debugId, JSON.stringify(sourceMap));
          } finally {
            rm(mapFile);
          }
        })
      );
    }
    await Promise.allSettled(promises);
    store.close?.();

    await runAfterProductionCompile?.(args);
  };
  return nextConfig;
}
