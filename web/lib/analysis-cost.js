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
  return {
    currency: String(value.currency || "USD").trim() || "USD",
    amountUsd,
    complete: value.complete,
    providerCalls: nonNegativeInteger(value.provider_calls),
    pricedCalls: nonNegativeInteger(value.priced_calls),
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
    providerCalls: 0,
    pricedCalls: 0,
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
    providerCalls: accumulator.providerCalls + cost.providerCalls,
    pricedCalls: accumulator.pricedCalls + cost.pricedCalls,
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
  return {
    amountText: accumulator.complete
      ? amount
      : accumulator.amountUsd > 0
        ? `当前已记录 ${amount}`
        : "",
    statusText: accumulator.complete
      ? "本次费用已结算"
      : "已记录费用，仍有部分未结算",
    detailText: [
      `模型调用 ${accumulator.providerCalls} 次 · 已返回价格 ${accumulator.pricedCalls} 次${
        accumulator.pendingJobs > 0 ? ` · 待结算任务 ${accumulator.pendingJobs} 个` : ""
      }`,
      `输入 ${accumulator.inputTokens} tokens · 输出 ${accumulator.outputTokens} tokens`,
    ].join("\n"),
  };
}
