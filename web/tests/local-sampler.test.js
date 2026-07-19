import assert from "node:assert/strict";
import test from "node:test";

import { validateClientSamplePlan } from "../lib/local-sampler.js";


function plan(overrides = {}) {
  return {
    plan_id: "watch_plan_1",
    managed_by: "client",
    client_upload_required: true,
    media_id: "local:asset-1",
    media_revision: "revision-1",
    timeline_epoch: 2,
    purpose: "rolling",
    target_timestamps_ms: [10_000, 20_000],
    allowed_start_ms: 10_000,
    allowed_end_ms: 20_000,
    max_frames: 2,
    accepted_image_mime_types: ["image/jpeg"],
    expires_at: "2026-01-01T00:02:00Z",
    ...overrides,
  };
}

const expected = {
  mediaId: "local:asset-1",
  mediaRevision: "revision-1",
  timelineEpoch: 2,
};

test("accepts a current client sample plan", () => {
  const value = plan();
  assert.equal(
    validateClientSamplePlan(value, expected, Date.parse("2026-01-01T00:01:00Z")),
    value,
  );
});

test("rejects stale media, revision, epoch, range, and expiry before reading frames", () => {
  const now = Date.parse("2026-01-01T00:01:00Z");
  assert.throws(
    () => validateClientSamplePlan(plan({ media_id: "local:asset-2" }), expected, now),
    /不属于当前视频/,
  );
  assert.throws(
    () => validateClientSamplePlan(plan({ media_revision: "revision-2" }), expected, now),
    /版本已经变化/,
  );
  assert.throws(
    () => validateClientSamplePlan(plan({ timeline_epoch: 3 }), expected, now),
    /时间轴已经变化/,
  );
  assert.throws(
    () => validateClientSamplePlan(plan({ target_timestamps_ms: [9_999] }), expected, now),
    /超出允许范围/,
  );
  assert.throws(
    () => validateClientSamplePlan(
      plan({ expires_at: "2026-01-01T00:00:59Z" }),
      expected,
      now,
    ),
    /已经过期/,
  );
});
