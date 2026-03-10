import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreHandler } from "./handler.js";
import { createHttpStore } from "./http.js";
import type { SourceMapStore } from "./types.js";

function createMemoryStore(): SourceMapStore {
  const map = new Map<string, string>();
  return {
    get(debugId) {
      return map.get(debugId) ?? null;
    },
    put(debugId, content) {
      map.set(debugId, content);
    },
  };
}

describe("Store Handler", () => {
  let store: SourceMapStore;
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    store = createMemoryStore();
    handler = createStoreHandler(store);
  });

  it("GET /:debugId returns 200 with content for existing entry", async () => {
    const content = JSON.stringify({ version: 3, mappings: "AAAA" });
    await store.put("abc-123", content);

    const response = await handler(
      new Request("http://localhost/abc-123", { method: "GET" })
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(JSON.parse(content));
  });

  it("GET /:debugId returns 404 for non-existent entry", async () => {
    const response = await handler(
      new Request("http://localhost/missing-id", { method: "GET" })
    );
    expect(response.status).toBe(404);
  });

  it("PUT /:debugId stores content and returns 204", async () => {
    const content = JSON.stringify({ version: 3, mappings: "CCCC" });
    const response = await handler(
      new Request("http://localhost/new-id", {
        method: "PUT",
        body: content,
        headers: { "content-type": "application/json" },
      })
    );
    expect(response.status).toBe(204);

    const stored = await store.get("new-id");
    expect(JSON.parse(stored!)).toEqual(JSON.parse(content));
  });

  it("POST method returns 405", async () => {
    const response = await handler(
      new Request("http://localhost/some-id", {
        method: "POST",
        body: "{}",
      })
    );
    expect(response.status).toBe(405);
  });

  it("DELETE method returns 405", async () => {
    const response = await handler(
      new Request("http://localhost/some-id", { method: "DELETE" })
    );
    expect(response.status).toBe(405);
  });

  it("missing debugId (root path) returns 400", async () => {
    const response = await handler(
      new Request("http://localhost/", { method: "GET" })
    );
    expect(response.status).toBe(400);
  });

  it("GET response has content-type: application/json header", async () => {
    await store.put("typed-id", '{"version":3}');
    const response = await handler(
      new Request("http://localhost/typed-id", { method: "GET" })
    );
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("PUT then GET round-trip through handler", async () => {
    const content = JSON.stringify({
      version: 3,
      sources: ["app.ts"],
      mappings: "DDDD",
    });

    const putResponse = await handler(
      new Request("http://localhost/round-trip-id", {
        method: "PUT",
        body: content,
        headers: { "content-type": "application/json" },
      })
    );
    expect(putResponse.status).toBe(204);

    const getResponse = await handler(
      new Request("http://localhost/round-trip-id", { method: "GET" })
    );
    expect(getResponse.status).toBe(200);
    const body = await getResponse.text();
    expect(JSON.parse(body)).toEqual(JSON.parse(content));
  });
});

describe("HTTP Store + Handler Integration", () => {
  let backingStore: SourceMapStore;
  let httpStore: SourceMapStore;
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    backingStore = createMemoryStore();
    handler = createStoreHandler(backingStore);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        handler(new Request(url, init))
      )
    );

    httpStore = createHttpStore("http://localhost:8081");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("put via HTTP store then get via HTTP store (round-trip)", async () => {
    const content = JSON.stringify({
      version: 3,
      sources: ["main.ts"],
      mappings: "EEEE",
    });

    await httpStore.put("http-round-trip", content);
    const result = await httpStore.get("http-round-trip");
    expect(JSON.parse(result!)).toEqual(JSON.parse(content));
  });

  it("put via backing store then get via HTTP store (cross-store)", async () => {
    const content = JSON.stringify({
      version: 3,
      sources: ["cross.ts"],
      mappings: "FFFF",
    });

    await backingStore.put("cross-store-id", content);
    const result = await httpStore.get("cross-store-id");
    expect(JSON.parse(result!)).toEqual(JSON.parse(content));
  });

  it("get non-existent via HTTP store returns null", async () => {
    const result = await httpStore.get("no-such-id");
    expect(result).toBeNull();
  });

  it("URL encoding of debugId with special characters", async () => {
    const id = "debug.id-with-special.chars";
    const content = JSON.stringify({ version: 3 });

    await httpStore.put(id, content);

    const fetchMock = vi.mocked(globalThis.fetch);
    const lastCallUrl = String(fetchMock.mock.calls.at(-1)![0]);
    expect(lastCallUrl).toContain(encodeURIComponent(id));

    const result = await httpStore.get(id);
    expect(JSON.parse(result!)).toEqual(JSON.parse(content));
  });
});

describe("HTTP Store (unit)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trailing slash in base URL is normalized", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const store = createHttpStore("http://example.com/store/");
    await store.get("some-id");

    const calledUrl = String(fetchMock.mock.calls[0]![0]);
    expect(calledUrl).toBe("http://example.com/store/some-id");
    expect(calledUrl).not.toContain("//some-id");
  });

  it("get returns null for 404 response", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const store = createHttpStore("http://example.com");
    const result = await store.get("missing");
    expect(result).toBeNull();
  });

  it("get throws for 500 response", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const store = createHttpStore("http://example.com");
    await expect(store.get("error-id")).rejects.toThrow(
      "Store GET failed: HTTP 500"
    );
  });

  it("put throws for non-ok response", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(
      new Response("Service Unavailable", { status: 503 })
    );

    const store = createHttpStore("http://example.com");
    await expect(store.put("id", '{"version":3}')).rejects.toThrow(
      "Store PUT failed: HTTP 503"
    );
  });
});
