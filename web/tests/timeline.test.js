import assert from "node:assert/strict";
import test from "node:test";

import { PlaybackTimeline } from "../lib/timeline.js";

test("snapshots are monotonic inside an epoch", () => {
  const timeline = new PlaybackTimeline("local:demo");
  const first = timeline.next({
    playheadMs: 1_000,
    durationMs: 10_000,
    isPlaying: true,
  });
  const second = timeline.next({
    playheadMs: 2_000,
    durationMs: 10_000,
    isPlaying: true,
  });
  assert.equal(first.snapshot_seq, 1);
  assert.equal(second.snapshot_seq, 2);
  assert.equal(second.timeline_epoch, 0);
});

test("a new epoch restarts the snapshot sequence", () => {
  const timeline = new PlaybackTimeline("local:demo");
  timeline.next({ playheadMs: 1_000, durationMs: 10_000, isPlaying: true });
  timeline.beginNewEpoch();
  const snapshot = timeline.next({
    playheadMs: 8_000,
    durationMs: 10_000,
    isPlaying: false,
  });
  assert.equal(snapshot.timeline_epoch, 1);
  assert.equal(snapshot.snapshot_seq, 1);
});
