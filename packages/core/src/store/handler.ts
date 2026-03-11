import type { SourceMapStore } from "./types.js";

/**
 * Creates an HTTP request handler that exposes a {@link SourceMapStore} as a
 * REST API.
 *
 * Routes:
 * - `GET  /:debugId` — retrieves a source map (404 if not found)
 * - `PUT  /:debugId` — stores a source map (body = JSON string)
 *
 * Pair with {@link createHttpStore} on the client side.
 *
 * @example
 * ```ts
 * import { createSqliteStore, createStoreHandler } from 'smapped-traces/store'
 *
 * const store = createSqliteStore('./sourcemaps.db')
 * Bun.serve({ port: 8081, fetch: createStoreHandler(store) })
 * ```
 */
export function createStoreHandler(
  store: SourceMapStore
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const debugId = segments.at(-1);

    if (!debugId) {
      return new Response(null, { status: 400 });
    }

    if (request.method === "GET") {
      const content = await store.get(debugId);
      if (content === null) {
        return new Response(null, { status: 404 });
      }
      return new Response(content, {
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "PUT") {
      const content = await request.text();
      await store.put(debugId, content);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  };
}
