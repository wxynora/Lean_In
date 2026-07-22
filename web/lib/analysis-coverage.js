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

export function analysisCoverageLabel(status, coveredUntilMs, playheadMs, latestJobStatus = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const normalizedJobStatus = String(latestJobStatus || "").trim().toLowerCase();
  const running = ["queued", "running"].includes(normalizedJobStatus)
    || ["pending", "analyzing"].includes(normalizedStatus);
  if (normalizedStatus === "failed") return "剧情分析失败";
  if (normalizedStatus === "unavailable") return "剧情分析不可用";
  const aheadMs = coverageAheadMs(coveredUntilMs, playheadMs);
  const lead = `已提前解析 ${formatLeadDuration(aheadMs)}剧情`;
  if (normalizedStatus === "degraded") {
    return `${lead} · 暂时降级${running ? " · 正在解析后续剧情" : ""}`;
  }
  return `${lead}${running ? " · 正在解析后续剧情" : ""}`;
}
