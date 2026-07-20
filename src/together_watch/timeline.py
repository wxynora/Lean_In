from __future__ import annotations

from dataclasses import dataclass

from .models import PlaybackSnapshot, SnapshotApplyResult


MAX_FUTURE_WINDOW_MS = 120_000


def merge_cached_intervals(
    intervals: list[tuple[int, int]] | tuple[tuple[int, int], ...],
) -> tuple[tuple[int, int], ...]:
    """Normalize media-time coverage independently of timeline epochs."""

    normalized = sorted(
        (max(0, int(start_ms)), max(0, int(end_ms)))
        for start_ms, end_ms in intervals
        if int(end_ms) > int(start_ms)
    )
    merged: list[tuple[int, int]] = []
    for start_ms, end_ms in normalized:
        if merged and start_ms <= merged[-1][1] + 1000:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end_ms))
        else:
            merged.append((start_ms, end_ms))
    return tuple(merged)


def cached_interval_at(
    intervals: list[tuple[int, int]] | tuple[tuple[int, int], ...],
    position_ms: int,
) -> tuple[int, int] | None:
    position = max(0, int(position_ms))
    for start_ms, end_ms in merge_cached_intervals(intervals):
        if start_ms <= position <= end_ms:
            return start_ms, end_ms
    return None


def advance_through_cached_intervals(
    intervals: list[tuple[int, int]] | tuple[tuple[int, int], ...],
    position_ms: int,
) -> int:
    position = max(0, int(position_ms))
    for start_ms, end_ms in merge_cached_intervals(intervals):
        if start_ms > position + 1000:
            break
        if start_ms <= position + 1000 and end_ms > position:
            position = end_ms
    return position


@dataclass(slots=True)
class TimelineTracker:
    media_id: str
    snapshot: PlaybackSnapshot | None = None

    def apply(self, candidate: PlaybackSnapshot) -> SnapshotApplyResult:
        if candidate.media_id != self.media_id:
            return SnapshotApplyResult(False, "media_mismatch")

        current = self.snapshot
        if current is None:
            self.snapshot = candidate
            return SnapshotApplyResult(True)

        if candidate.timeline_epoch < current.timeline_epoch:
            return SnapshotApplyResult(False, "stale_timeline_epoch")
        if (
            candidate.timeline_epoch == current.timeline_epoch
            and candidate.snapshot_seq <= current.snapshot_seq
        ):
            return SnapshotApplyResult(False, "non_monotonic_snapshot_seq")

        self.snapshot = candidate
        return SnapshotApplyResult(True)


def reply_arrival_until_ms(
    snapshot: PlaybackSnapshot,
    reply_lead_ms: int,
    *,
    max_future_window_ms: int = MAX_FUTURE_WINDOW_MS,
) -> int:
    if reply_lead_ms < 0:
        raise ValueError("reply_lead_ms must be non-negative")
    if max_future_window_ms < 0:
        raise ValueError("max_future_window_ms must be non-negative")
    if not snapshot.is_playing or reply_lead_ms == 0:
        return snapshot.playhead_ms

    media_advance_ms = round(reply_lead_ms * float(snapshot.playback_rate))
    bounded_advance_ms = min(media_advance_ms, max_future_window_ms)
    return min(snapshot.duration_ms, snapshot.playhead_ms + bounded_advance_ms)


def scheduled_future_until_ms(
    snapshot: PlaybackSnapshot,
    *,
    max_future_window_ms: int = MAX_FUTURE_WINDOW_MS,
) -> int:
    if max_future_window_ms < 0:
        raise ValueError("max_future_window_ms must be non-negative")
    return min(snapshot.duration_ms, snapshot.playhead_ms + max_future_window_ms)
