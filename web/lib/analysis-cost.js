function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function parseAnalysisCost(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("结束一起看费用返回为空");
  }
  const amountUsd = Number(value.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error("一起看剧情解析费用格式无效");
  }
  if (typeof value.complete !== "boolean") {
    throw new Error("一起看剧情解析费用缺少结算状态");
  }
  const providerCalls = nonNegativeInteger(value.provider_calls);
  const pricedCalls = nonNegativeInteger(value.priced_calls);
  const pricingComplete = typeof value.pricing_complete === "boolean"
    ? value.pricing_complete
    : pricedCalls >= providerCalls;
  return {
    currency: String(value.currency || "USD").trim() || "USD",
    amountUsd,
    complete: value.complete,
    pricingComplete,
    providerCalls,
    pricedCalls,
    unpricedCalls: nonNegativeInteger(
      value.unpriced_calls ?? Math.max(0, providerCalls - pricedCalls),
    ),
    pendingJobs: nonNegativeInteger(value.pending_jobs),
    inputTokens: nonNegativeInteger(value.input_tokens),
    outputTokens: nonNegativeInteger(value.output_tokens),
  };
}

export function createAnalysisCostAccumulator() {
  return {
    currency: "",
    amountUsd: 0,
    complete: true,
    pricingComplete: true,
    providerCalls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    pendingJobs: 0,
    inputTokens: 0,
    outputTokens: 0,
    recordedSessionIds: new Set(),
  };
}

export function recordAnalysisCost(accumulator, sessionId, rawCost) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId || accumulator.recordedSessionIds.has(normalizedSessionId)) {
    return accumulator;
  }
  const cost = parseAnalysisCost(rawCost);
  return {
    currency: accumulator.currency || cost.currency,
    amountUsd: accumulator.amountUsd + cost.amountUsd,
    complete: accumulator.complete && cost.complete,
    pricingComplete: accumulator.pricingComplete && cost.pricingComplete,
    providerCalls: accumulator.providerCalls + cost.providerCalls,
    pricedCalls: accumulator.pricedCalls + cost.pricedCalls,
    unpricedCalls: accumulator.unpricedCalls + cost.unpricedCalls,
    pendingJobs: accumulator.pendingJobs + cost.pendingJobs,
    inputTokens: accumulator.inputTokens + cost.inputTokens,
    outputTokens: accumulator.outputTokens + cost.outputTokens,
    recordedSessionIds: new Set([...accumulator.recordedSessionIds, normalizedSessionId]),
  };
}

export function formatAnalysisCost(amountUsd, currency = "USD") {
  let normalized = Math.max(0, Number(amountUsd) || 0).toFixed(8);
  if (normalized.includes(".")) normalized = normalized.replace(/0+$/, "").replace(/\.$/, "");
  return `$${normalized || "0"} ${String(currency || "USD").trim() || "USD"}`;
}

export function analysisCostPresentation(accumulator) {
  const amount = formatAnalysisCost(accumulator.amountUsd, accumulator.currency);
  const fullySettled = accumulator.complete && accumulator.pricingComplete;
  return {
    amountText: fullySettled
      ? amount
      : accumulator.amountUsd > 0
        ? `当前已记录 ${amount}`
        : "",
    statusText: !accumulator.complete
      ? "已记录费用，仍有任务未结束"
      : accumulator.pricingComplete
        ? "本次费用已结算"
        : "任务已结束，仍有调用未返回价格",
    detailText: [
      `模型调用 ${accumulator.providerCalls} 次 · 已返回价格 ${accumulator.pricedCalls} 次${
        accumulator.unpricedCalls > 0 ? ` · 未返回价格 ${accumulator.unpricedCalls} 次` : ""
      }${
        accumulator.pendingJobs > 0 ? ` · 待结算任务 ${accumulator.pendingJobs} 个` : ""
      }`,
      `输入 ${accumulator.inputTokens} tokens · 输出 ${accumulator.outputTokens} tokens`,
    ].join("\n"),
  };
}
