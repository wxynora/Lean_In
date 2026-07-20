from __future__ import annotations

from dataclasses import dataclass


DEFAULT_INITIAL_READY_BUFFER_MS = 300_000
DEFAULT_PREFETCH_AHEAD_MS = 1_800_000
DEFAULT_ROLLING_BATCH_MS = 140_000


@dataclass(frozen=True, slots=True)
class RollingPrefetchDecision:
    should_schedule: bool
    reason: str
    target_until_ms: int
    batch_start_ms: int
    batch_end_ms: int


def plan_rolling_prefetch(
    *,
    playhead_ms: int,
    next_start_ms: int,
    duration_ms: int,
    content_end_ms: int | None = None,
    max_ahead_ms: int = DEFAULT_PREFETCH_AHEAD_MS,
    batch_span_ms: int = DEFAULT_ROLLING_BATCH_MS,
) -> RollingPrefetchDecision:
    """Plan one full rolling batch without chasing small playhead changes."""

    playhead = max(0, int(playhead_ms))
    start = max(0, int(next_start_ms))
    ahead = max(1, int(max_ahead_ms))
    batch_span = max(1, int(batch_span_ms))
    terminal_candidates = [
        value
        for value in (int(duration_ms), content_end_ms)
        if value and value > 0
    ]
    terminal_end = min(int(value) for value in terminal_candidates) if terminal_candidates else None
    target_until = playhead + ahead
    if terminal_end is not None:
        target_until = min(target_until, terminal_end)

    if start >= target_until:
        return RollingPrefetchDecision(False, "coverage_ready", target_until, start, start)

    reaches_terminal = terminal_end is not None and target_until >= terminal_end
    if target_until - start < batch_span and not reaches_terminal:
        return RollingPrefetchDecision(False, "coverage_refill_wait", target_until, start, start)

    return RollingPrefetchDecision(
        True,
        "extend_future_coverage",
        target_until,
        start,
        min(target_until, start + batch_span),
    )
