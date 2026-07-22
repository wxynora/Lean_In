import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisCoverageLabel,
  coverageAheadMs,
  formatLeadDuration,
} from "../lib/analysis-coverage.js";


test("coverage is measured ahead of the current playhead", () => {
  assert.equal(coverageAheadMs(300_000, 100_000), 200_000);
  assert.equal(coverageAheadMs(90_000, 100_000), 0);
});

test("lead duration uses explicit minute and second wording", () => {
  assert.equal(formatLeadDuration(45_900), "45秒");
  assert.equal(formatLeadDuration(180_000), "3分钟");
  assert.equal(formatLeadDuration(200_000), "3分20秒");
});

test("analysis status states the actual prepared plot lead", () => {
  assert.equal(
    analysisCoverageLabel("pending", 300_000, 100_000),
    "已提前解析 3分20秒剧情 · 正在解析后续剧情",
  );
  assert.equal(
    analysisCoverageLabel("pending", 90_000, 100_000),
    "已提前解析 0秒剧情 · 正在解析后续剧情",
  );
  assert.equal(analysisCoverageLabel("failed", 300_000, 100_000), "剧情分析失败");
  assert.equal(
    analysisCoverageLabel("degraded", 300_000, 100_000),
    "已提前解析 3分20秒剧情 · 暂时降级",
  );
  assert.equal(
    analysisCoverageLabel("degraded", 300_000, 100_000, "running"),
    "已提前解析 3分20秒剧情 · 暂时降级 · 正在解析后续剧情",
  );
});
