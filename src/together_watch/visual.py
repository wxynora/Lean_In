from __future__ import annotations

from collections.abc import Sequence

from .models import ContextEnvelope, PlotChunk, VisualFrame, VisualPanel


def _chunk_midpoint(chunk: PlotChunk) -> int:
    return max(0, (chunk.start_ms + chunk.end_ms) // 2)


def _current_target(envelope: ContextEnvelope) -> int:
    if envelope.current_chunks:
        return min(
            envelope.message_playhead_ms,
            _chunk_midpoint(envelope.current_chunks[-1]),
        )
    return envelope.message_playhead_ms


def _related_target(envelope: ContextEnvelope) -> int:
    if envelope.related_watched_chunks:
        selected = next(
            (
                chunk
                for chunk in envelope.related_watched_chunks
                if chunk.chunk_id == envelope.visual_related_chunk_id
            ),
            envelope.related_watched_chunks[-1],
        )
        return _chunk_midpoint(selected)
    return max(0, envelope.message_playhead_ms - 15_000)


def _arrival_target(envelope: ContextEnvelope) -> int:
    if envelope.reply_arrival_chunks:
        return min(
            envelope.reply_arrival_until_ms,
            _chunk_midpoint(envelope.reply_arrival_chunks[-1]),
        )
    return envelope.reply_arrival_until_ms


def _nearest(
    frames: Sequence[VisualFrame],
    target_ms: int,
    *,
    used_ids: set[str],
    max_distance_ms: int | None,
) -> VisualFrame | None:
    available = [frame for frame in frames if frame.frame_id not in used_ids]
    if not available:
        return None
    selected = min(
        available,
        key=lambda frame: (abs(frame.at_ms - target_ms), frame.at_ms, frame.frame_id),
    )
    if max_distance_ms is not None and abs(selected.at_ms - target_ms) > max_distance_ms:
        return None
    return selected


def select_contact_sheet_panels(
    frames: Sequence[VisualFrame],
    envelope: ContextEnvelope,
) -> tuple[VisualPanel, ...]:
    """Select four deduplicated plot-aware frames for a host-built contact sheet."""

    eligible = tuple(
        sorted(
            (
                frame
                for frame in frames
                if frame.session_id == envelope.session_id
                and frame.media_id == envelope.media_id
                and frame.timeline_epoch == envelope.timeline_epoch
                and frame.at_ms <= envelope.reply_arrival_until_ms
            ),
            key=lambda frame: (frame.at_ms, frame.frame_id),
        )
    )
    targets = (
        ("A", "当前剧情", _current_target(envelope), 35_000),
        ("B", "相关已观看片段", _related_target(envelope), None),
        ("C", "预计抵达剧情", _arrival_target(envelope), 35_000),
        ("D", "预计回复抵达", envelope.reply_arrival_until_ms, 35_000),
    )
    selected: list[VisualPanel] = []
    used_ids: set[str] = set()
    for role, purpose, target_ms, max_distance_ms in targets:
        frame = _nearest(
            eligible,
            target_ms,
            used_ids=used_ids,
            max_distance_ms=max_distance_ms,
        )
        if frame is None:
            continue
        used_ids.add(frame.frame_id)
        selected.append(VisualPanel(role=role, purpose=purpose, frame=frame))
    return tuple(selected)
