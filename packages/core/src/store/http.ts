import type { SourceMapStore } from "./types.js";

/**
 * Creates a source map store that communicates with a remote store handler
 * over HTTP.
 *
 * Pair with {@link createStoreHandler} on the server side.
 *
 * @param baseUrl The base URL of the store handler (e.g. "https://sourcemaps.example.com").
 */
const TRAILING_SLASH = /\/$/;

export function createHttpStore(baseUrl: string): SourceMapStore {
  const url = baseUrl.replace(TRAILING_SLASH, "");

  return {
    async get(debugId) {
      const response = await fetch(`${url}/${encodeURIComponent(debugId)}`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Store GET failed: HTTP ${response.status}`);
      }
      return response.text();
    },

    async put(debugId, content) {
      const response = await fetch(`${url}/${encodeURIComponent(debugId)}`, {
        method: "PUT",
        body: content,
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Store PUT failed: HTTP ${response.status}`);
      }
    },
  };
}
