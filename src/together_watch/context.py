from __future__ import annotations

from collections.abc import Sequence

from .models import ContextEnvelope, KnowledgeMode, PlaybackSnapshot, PlotChunk, SessionMode
from .timeline import reply_arrival_until_ms, scheduled_future_until_ms


CURRENT_LOOKBACK_MS = 30_000


def _ordered(chunks: Sequence[PlotChunk]) -> tuple[PlotChunk, ...]:
    return tuple(sorted(chunks, key=lambda chunk: (chunk.start_ms, chunk.end_ms, chunk.chunk_id)))


def build_context_envelope(
    *,
    session_id: str,
    snapshot: PlaybackSnapshot,
    mode: SessionMode,
    chunks: Sequence[PlotChunk],
    related_watched_chunks: Sequence[PlotChunk] = (),
    story_background: str = "",
) -> ContextEnvelope:
    active_chunks = [
        chunk
        for chunk in chunks
        if chunk.session_id == session_id
        and chunk.timeline_epoch == snapshot.timeline_epoch
    ]
    playhead_ms = snapshot.playhead_ms
    arrival_until_ms = reply_arrival_until_ms(snapshot, mode.reply_lead_ms)
    future_until_ms = scheduled_future_until_ms(snapshot)
    current_start_ms = max(0, playhead_ms - CURRENT_LOOKBACK_MS)

    current = [
        chunk
        for chunk in active_chunks
        if chunk.start_ms <= playhead_ms and chunk.end_ms > current_start_ms
    ]
    current_ids = {chunk.chunk_id for chunk in current}

    reply_arrival = [
        chunk
        for chunk in active_chunks
        if chunk.chunk_id not in current_ids
        and chunk.start_ms < arrival_until_ms
        and chunk.end_ms > playhead_ms
    ]
    reply_ids = {chunk.chunk_id for chunk in reply_arrival}

    scheduled_future = [
        chunk
        for chunk in active_chunks
        if chunk.chunk_id not in current_ids
        and chunk.chunk_id not in reply_ids
        and chunk.start_ms < future_until_ms
        and chunk.end_ms > arrival_until_ms
    ]

    safe_related = [
        chunk
        for chunk in related_watched_chunks
        if chunk.session_id == session_id
        and chunk.timeline_epoch == snapshot.timeline_epoch
        and chunk.end_ms <= playhead_ms
        and chunk.chunk_id not in current_ids
    ]

    background = story_background.strip()
    if mode.knowledge_mode is KnowledgeMode.KNOWN:
        background = ""

    return ContextEnvelope(
        session_id=session_id,
        media_id=snapshot.media_id,
        message_playhead_ms=playhead_ms,
        reply_arrival_until_ms=arrival_until_ms,
        story_background=background,
        related_watched_chunks=_ordered(safe_related),
        current_chunks=_ordered(current),
        reply_arrival_chunks=_ordered(reply_arrival),
        scheduled_future_chunks=_ordered(scheduled_future),
    )
