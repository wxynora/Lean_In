import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisDegradedReason,
  shouldResumeDirectly,
} from "../lib/watch-status.js";


test("confirmed resumed sessions bypass the preparation UI", () => {
  assert.equal(shouldResumeDirectly({
    resumed_from_progress: true,
    preparation: { status: "confirmed" },
  }), true);
  assert.equal(shouldResumeDirectly({
    resumed_from_progress: true,
    preparation: { status: "searching_subtitles" },
  }), false);
  assert.equal(shouldResumeDirectly({
    resumed_from_progress: false,
    preparation: { status: "confirmed" },
  }), false);
});

test("degraded analysis always exposes a truthful reason", () => {
  assert.equal(
    analysisDegradedReason({ status: "degraded", error: "字幕覆盖不足" }),
    "字幕覆盖不足",
  );
  assert.equal(
    analysisDegradedReason(
      { status: "degraded" },
      { latest_job_error: "画面取材失败" },
    ),
    "画面取材失败",
  );
  assert.equal(
    analysisDegradedReason({ status: "degraded" }),
    "服务端未返回降级原因",
  );
});
