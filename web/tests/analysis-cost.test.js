import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisCostPresentation,
  createAnalysisCostAccumulator,
  formatAnalysisCost,
  parseAnalysisCost,
  recordAnalysisCost,
} from "../lib/analysis-cost.js";


const completeCost = {
  currency: "USD",
  amount_usd: 0.004,
  complete: true,
  provider_calls: 2,
  priced_calls: 2,
  pending_jobs: 0,
  input_tokens: 620,
  output_tokens: 180,
};

test("analysis cost parses and formats the gateway contract", () => {
  assert.deepEqual(parseAnalysisCost(completeCost), {
    currency: "USD",
    amountUsd: 0.004,
    complete: true,
    providerCalls: 2,
    pricedCalls: 2,
    pendingJobs: 0,
    inputTokens: 620,
    outputTokens: 180,
  });
  assert.equal(formatAnalysisCost(0.004, "USD"), "$0.004 USD");
});

test("analysis cost accumulates parts once per session", () => {
  let total = createAnalysisCostAccumulator();
  total = recordAnalysisCost(total, "watch-p1", completeCost);
  total = recordAnalysisCost(total, "watch-p1", completeCost);
  total = recordAnalysisCost(total, "watch-p2", {
    ...completeCost,
    amount_usd: 0.0025,
    complete: false,
    provider_calls: 1,
    priced_calls: 0,
    pending_jobs: 1,
    input_tokens: 200,
    output_tokens: 60,
  });

  assert.ok(Math.abs(total.amountUsd - 0.0065) < 0.000000001);
  assert.equal(total.recordedSessionIds.size, 2);
  assert.equal(total.complete, false);
  assert.equal(total.providerCalls, 3);
  assert.equal(total.pendingJobs, 1);
  assert.deepEqual(analysisCostPresentation(total), {
    amountText: "当前已记录 $0.0065 USD",
    statusText: "已记录费用，仍有部分未结算",
    detailText: "模型调用 3 次 · 已返回价格 2 次 · 待结算任务 1 个\n输入 820 tokens · 输出 240 tokens",
  });
});

test("an incomplete zero is not presented as free usage", () => {
  const total = recordAnalysisCost(createAnalysisCostAccumulator(), "watch-p1", {
    ...completeCost,
    amount_usd: 0,
    complete: false,
    provider_calls: 1,
    priced_calls: 0,
    pending_jobs: 1,
  });
  assert.equal(analysisCostPresentation(total).amountText, "");
  assert.throws(() => parseAnalysisCost({ amount_usd: 0 }), /缺少结算状态/);
});
