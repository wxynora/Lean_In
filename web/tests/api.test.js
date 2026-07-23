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

test("gateway client reports the first displayed assistant latency", async () => {
  const calls = [];
  const client = new WatchApiClient(
    { gatewayBaseUrl: "https://gateway.example" },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  await client.reportReplyDisplayed("watch-1", "job-1", 12_345.6);

  assert.equal(
    calls[0].url,
    "https://gateway.example/miniapp-api/watch/sessions/watch-1/reply-displayed",
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    job_id: "job-1",
    visible_latency_ms: 12_346,
  });
});

test("explicit viewing actions are distinct from internal session cleanup", async () => {
  const calls = [];
  const client = new WatchApiClient(
    { gatewayBaseUrl: "https://gateway.example" },
    async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  await client.endSession("watch-1");
  await client.endSession("watch-2", { viewingAction: "save_progress" });
  await client.endSession("watch-3", { viewingAction: "complete" });

  assert.equal(calls[0].url, "https://gateway.example/miniapp-api/watch/sessions/watch-1");
  assert.equal(
    calls[1].url,
    "https://gateway.example/miniapp-api/watch/sessions/watch-2?viewing_action=save_progress",
  );
  assert.equal(
    calls[2].url,
    "https://gateway.example/miniapp-api/watch/sessions/watch-3?viewing_action=complete",
  );
});

test("viewing and ticket-frame APIs preserve the explicit capture contract", async () => {
  const calls = [];
  const client = new WatchApiClient(
    { gatewayBaseUrl: "https://gateway.example" },
    async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  await client.listViewings({ status: "recent", windowId: "web-window" });
  await client.listTicketFrameCaptures("viewing-1");
  await client.uploadTicketFrameCapture(
    "viewing-1",
    {
      session_id: "watch-1",
      media_id: "media-1",
      timeline_epoch: 2,
      at_ms: 42_000,
      width: 1280,
      height: 720,
      mime_type: "image/jpeg",
    },
    new Blob(["frame"], { type: "image/jpeg" }),
  );
  await client.selectTicketFrameCapture("viewing-1", "capture-1");
  await client.clearTicketFrame("viewing-1");

  assert.equal(
    calls[0].url,
    "https://gateway.example/miniapp-api/watch/viewings?status=recent&window_id=web-window",
  );
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[2].options.method, "POST");
  assert.ok(calls[2].options.body instanceof FormData);
  assert.deepEqual(JSON.parse(calls[2].options.body.get("metadata")), {
    session_id: "watch-1",
    media_id: "media-1",
    timeline_epoch: 2,
    at_ms: 42_000,
    width: 1280,
    height: 720,
    mime_type: "image/jpeg",
  });
  assert.equal(calls[3].options.method, "PUT");
  assert.equal(calls[4].options.method, "DELETE");
});
