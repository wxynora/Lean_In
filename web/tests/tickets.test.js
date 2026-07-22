import assert from "node:assert/strict";
import test from "node:test";

import {
  createTicketStore,
  createViewingDurationAccumulator,
  formatTicketDuration,
  normalizeRecentViewing,
  normalizeTicket,
  normalizeTicketCapture,
  observeViewingDuration,
  updateTicketAvatar,
} from "../lib/tickets.js";


test("viewing duration counts continuous playback but not pause, seek epoch, or speed twice", () => {
  let duration = createViewingDurationAccumulator();
  duration = observeViewingDuration(duration, {
    sessionId: "watch-1",
    observedAtMs: 1_000,
    snapshot: {
      playhead_ms: 0,
      is_playing: true,
      playback_rate: 2,
      timeline_epoch: 0,
      snapshot_seq: 1,
    },
  });
  duration = observeViewingDuration(duration, {
    sessionId: "watch-1",
    observedAtMs: 31_000,
    snapshot: {
      playhead_ms: 60_000,
      is_playing: false,
      playback_rate: 2,
      timeline_epoch: 0,
      snapshot_seq: 2,
    },
  });
  assert.equal(duration.totalMs, 30_000);

  duration = observeViewingDuration(duration, {
    sessionId: "watch-1",
    observedAtMs: 91_000,
    snapshot: {
      playhead_ms: 60_000,
      is_playing: false,
      playback_rate: 1,
      timeline_epoch: 0,
      snapshot_seq: 3,
    },
  });
  duration = observeViewingDuration(duration, {
    sessionId: "watch-1",
    observedAtMs: 101_000,
    snapshot: {
      playhead_ms: 240_000,
      is_playing: true,
      playback_rate: 1,
      timeline_epoch: 1,
      snapshot_seq: 1,
    },
  });
  assert.equal(duration.totalMs, 30_000);
});

test("ticket normalization uses end time, actual duration, and readable part labels", () => {
  const ticket = normalizeTicket({
    ticket_id: "ticket-1",
    viewing_id: "viewing-1",
    title: "Example",
    completed_at: "2026-07-22T10:30:00Z",
    played_duration_ms: 3_630_000,
    companion: { name: "{assistant}" },
    completed_parts: [
      { part_index: 1, part_title: "P1" },
      { part_index: 2, part_title: "P2" },
    ],
  });

  assert.equal(ticket.ended_at, "2026-07-22T10:30:00Z");
  assert.equal(ticket.part_label, "P1 / P2");
  assert.equal(formatTicketDuration(ticket.played_duration_ms), "一起看了 61 分钟");
});

test("ticket store deduplicates stable tickets and keeps the latest title", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = createTicketStore(storage, "tickets");
  store.save({
    ticket_id: "ticket-1",
    title: "Before",
    ended_at: "2026-07-22T10:30:00Z",
  });
  store.save({
    ticket_id: "ticket-1",
    title: "After",
    ended_at: "2026-07-22T10:30:00Z",
  });

  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].title, "After");
});

test("server refresh does not erase browser-local ticket art", () => {
  const values = new Map();
  const store = createTicketStore({
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  }, "ticket-art");
  store.save({
    ticket_id: "ticket-art-1",
    title: "Local",
    local_back_image_url: "data:image/jpeg;base64,back",
    viewer: { avatar_url: "data:image/jpeg;base64,avatar" },
  });
  store.save({ ticket_id: "ticket-art-1", title: "Server title" });

  assert.equal(store.list()[0].title, "Server title");
  assert.equal(store.list()[0].local_back_image_url, "data:image/jpeg;base64,back");
  assert.equal(store.list()[0].viewer.avatar_url, "data:image/jpeg;base64,avatar");
});

test("ticket avatars can be edited independently and persist with the ticket", () => {
  const original = normalizeTicket({
    ticket_id: "ticket-avatars",
    title: "Avatar Test",
    companion: { name: "{assistant}", avatar_url: "before-companion" },
    viewer: { name: "Viewer", avatar_url: "before-viewer" },
  });
  const edited = updateTicketAvatar(original, "viewer", "data:image/webp;base64,viewer");

  assert.equal(original.viewer.avatar_url, "before-viewer");
  assert.equal(edited.companion.avatar_url, "before-companion");
  assert.equal(edited.viewer.avatar_url, "data:image/webp;base64,viewer");

  const values = new Map();
  const store = createTicketStore({
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  }, "avatar-tickets");
  store.save(edited);
  assert.equal(store.list()[0].viewer.avatar_url, "data:image/webp;base64,viewer");
});

test("ticket keeps a server capture and a browser-local back image", () => {
  const ticket = normalizeTicket({
    ticket_id: "ticket-frame",
    viewing_id: "viewing-frame",
    back_frame: {
      frame_id: "capture-20",
      media_id: "media-1",
      at_ms: 20_000,
      image_url: "https://example.test/frame.jpg",
    },
    local_back_image_url: "data:image/jpeg;base64,local",
  });
  assert.equal(ticket.server_back_frame_id, "capture-20");
  assert.equal(ticket.server_back_frame_url, "https://example.test/frame.jpg");
  assert.equal(ticket.local_back_image_url, "data:image/jpeg;base64,local");
});

test("recent viewing normalization separates resume progress from completed tickets", () => {
  const recent = normalizeRecentViewing({
    viewing_id: "viewing-recent",
    status_text: "已看 23%",
    progress: {
      media: {
        title: "Example",
        source: "local_file",
        local_media: { media_revision: "revision-1" },
      },
      playback: { playhead_ms: 123_000 },
    },
  });
  assert.equal(recent.completed, false);
  assert.equal(recent.status_text, "已看 23%");
  assert.equal(recent.playhead_ms, 123_000);
  assert.equal(recent.media_revision, "revision-1");

  assert.deepEqual(normalizeTicketCapture({
    capture_id: "capture-1",
    media_id: "media-1",
    at_ms: 12_000,
    image_url: "frame.jpg",
  }), {
    frame_id: "capture-1",
    media_id: "media-1",
    at_ms: 12_000,
    image_url: "frame.jpg",
    selected_at: "",
  });
});
