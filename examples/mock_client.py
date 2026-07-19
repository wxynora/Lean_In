from __future__ import annotations

import json
from dataclasses import asdict

from together_watch import (
    ClientCapabilities,
    KnowledgeMode,
    MediaDescriptor,
    PlaybackSnapshot,
    PlotChunk,
    SessionMode,
    WatchCore,
)


def main() -> None:
    core = WatchCore()
    session = core.create_session(
        session_id="watch_demo",
        media=MediaDescriptor(
            media_id="demo:episode-1",
            source="html5",
            title="Demo Episode",
            duration_ms=600_000,
        ),
        mode=SessionMode(
            knowledge_mode=KnowledgeMode.NEEDS_SUMMARY,
            reply_lead_ms=30_000,
        ),
        capabilities=ClientCapabilities(
            playback_snapshot=True,
            danmaku_overlay=True,
            risk_overlay=True,
        ),
    )
    core.start_session(session.session_id)
    core.apply_snapshot(
        session.session_id,
        PlaybackSnapshot(
            media_id=session.media.media_id,
            playhead_ms=90_000,
            duration_ms=session.media.duration_ms,
            is_playing=True,
            playback_rate=1.0,
            timeline_epoch=0,
            snapshot_seq=1,
            captured_at="2026-01-01T00:00:00Z",
        ),
    )
    core.add_plot_chunks(
        session.session_id,
        [
            PlotChunk(
                chunk_id="chunk-1",
                session_id=session.session_id,
                timeline_epoch=0,
                start_ms=70_000,
                end_ms=85_000,
                summary="A locked door reveals the same red symbol seen earlier.",
            ),
            PlotChunk(
                chunk_id="chunk-2",
                session_id=session.session_id,
                timeline_epoch=0,
                start_ms=90_000,
                end_ms=105_000,
                summary="The group compares the symbol with a map.",
            ),
            PlotChunk(
                chunk_id="chunk-3",
                session_id=session.session_id,
                timeline_epoch=0,
                start_ms=108_000,
                end_ms=118_000,
                summary="One route on the map begins to glow.",
            ),
        ],
    )

    envelope = core.build_context(
        session.session_id,
        recent_user_messages="Was that the red symbol from the door?",
        story_background="The group is looking for a safe route out.",
    )
    action, validation = core.prepare_danmaku(
        session.session_id,
        target_ms=112_000,
        text="That route was hiding in plain sight.",
    )
    print(
        json.dumps(
            {
                "context": asdict(envelope),
                "danmaku": asdict(action),
                "action_valid": validation.valid,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
