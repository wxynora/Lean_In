import assert from "node:assert/strict";
import test from "node:test";

import { WatchApiClient, WatchApiError } from "../lib/api.js";


test("gateway client applies configurable base URL, path, and auth headers", async () => {
  const calls = [];
  const client = new WatchApiClient(
    {
      gatewayBaseUrl: "https://gateway.example",
      watchApiBasePath: "/custom/watch",
      getAuthHeaders: async () => ({ Authorization: "Bearer test" }),
    },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, session: { session_id: "watch-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  await client.createSession({ window_id: "web", media: {}, mode: {} });

  assert.equal(calls[0].url, "https://gateway.example/custom/watch/sessions");
  assert.equal(calls[0].options.headers.get("Authorization"), "Bearer test");
  assert.equal(calls[0].options.headers.get("Content-Type"), "application/json");
});

test("gateway client exposes structured API failures", async () => {
  const client = new WatchApiClient(
    { gatewayBaseUrl: "https://gateway.example" },
    async () => new Response(
      JSON.stringify({ ok: false, code: "client_lease_expired", error: "lease expired" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    ),
  );

  await assert.rejects(
    () => client.heartbeat("watch-1"),
    (error) => error instanceof WatchApiError
      && error.status === 409
      && error.code === "client_lease_expired",
  );
});
