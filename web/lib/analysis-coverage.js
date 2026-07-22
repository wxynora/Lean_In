function nonNegativeMilliseconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function coverageAheadMs(coveredUntilMs, playheadMs) {
  return Math.max(
    0,
    nonNegativeMilliseconds(coveredUntilMs) - nonNegativeMilliseconds(playheadMs),
  );
}

export function formatLeadDuration(value) {
  const totalSeconds = Math.floor(nonNegativeMilliseconds(value) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}秒`;
  if (seconds <= 0) return `${minutes}分钟`;
  return `${minutes}分${seconds}秒`;
}

export function analysisCoverageLabel(status, coveredUntilMs, playheadMs) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "failed") return "剧情分析不可用";
  const aheadMs = coverageAheadMs(coveredUntilMs, playheadMs);
  if (normalizedStatus === "degraded") {
    return `已提前解析 ${formatLeadDuration(aheadMs)}剧情 · 暂时降级`;
  }
  return aheadMs > 0
    ? `已提前解析 ${formatLeadDuration(aheadMs)}剧情`
    : "正在准备前方剧情";
}
