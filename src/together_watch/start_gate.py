from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class StartGateDecision:
    status: str
    reason: str
    can_play: bool
    should_persist_unlock: bool
    required_until_ms: int
    covered_until_ms: int


def evaluate_start_gate(
    *,
    started: bool,
    fear_mode: bool,
    playback_unlocked: bool,
    explicit_unprotected: bool,
    analysis_ready: bool,
    playhead_ms: int,
    covered_until_ms: int,
    required_buffer_ms: int,
    duration_ms: int,
    content_end_ms: int | None = None,
) -> StartGateDecision:
    playhead = max(0, int(playhead_ms))
    covered_until = max(0, int(covered_until_ms))
    required_until = playhead + max(0, int(required_buffer_ms))
    if content_end_ms is not None:
        required_until = min(required_until, max(0, int(content_end_ms)))
    elif duration_ms > 0:
        required_until = min(required_until, int(duration_ms))

    if not started:
        return StartGateDecision(
            status="awaiting_confirmation",
            reason="preparation_not_confirmed",
            can_play=False,
            should_persist_unlock=False,
            required_until_ms=required_until,
            covered_until_ms=covered_until,
        )

    coverage_ready = bool(analysis_ready and covered_until >= required_until)
    should_unlock = bool(
        not playback_unlocked
        and (not fear_mode or explicit_unprotected or coverage_ready)
    )
    effectively_unlocked = playback_unlocked or should_unlock
    if effectively_unlocked:
        unprotected = bool(explicit_unprotected)
        return StartGateDecision(
            status="unprotected" if unprotected else "ready",
            reason="explicit_unprotected_continue" if unprotected else "playback_unlocked",
            can_play=True,
            should_persist_unlock=should_unlock,
            required_until_ms=required_until,
            covered_until_ms=covered_until,
        )
    return StartGateDecision(
        status="buffering",
        reason="initial_fear_coverage_pending",
        can_play=False,
        should_persist_unlock=False,
        required_until_ms=required_until,
        covered_until_ms=covered_until,
    )
