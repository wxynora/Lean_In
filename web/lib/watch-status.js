function cleanStatus(value) {
  return String(value || "").trim().toLowerCase();
}

export function shouldResumeDirectly(session) {
  return Boolean(
    session?.resumed_from_progress === true
    && cleanStatus(session?.preparation?.status) === "confirmed",
  );
}

export function analysisDegradedReason(analysis, runtime = {}) {
  if (cleanStatus(analysis?.status) !== "degraded") {
    return String(analysis?.error || runtime?.latest_job_error || "").trim();
  }
  return String(
    analysis?.error
    || runtime?.latest_job_error
    || "服务端未返回降级原因",
  ).trim();
}
