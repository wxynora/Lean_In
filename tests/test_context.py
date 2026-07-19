from __future__ import annotations

import unittest

from together_watch import (
    Bm25PlotRecall,
    KnowledgeMode,
    PlaybackSnapshot,
    PlotChunk,
    SessionMode,
    build_context_envelope,
)


def chunk(
    chunk_id: str,
    start_ms: int,
    end_ms: int,
    summary: str,
    *,
    characters: tuple[str, ...] = (),
    session_id: str = "watch_demo",
    timeline_epoch: int = 0,
) -> PlotChunk:
    return PlotChunk(
        chunk_id=chunk_id,
        session_id=session_id,
        timeline_epoch=timeline_epoch,
        start_ms=start_ms,
        end_ms=end_ms,
        summary=summary,
        characters=characters,
    )


def playback() -> PlaybackSnapshot:
    return PlaybackSnapshot(
        media_id="demo:episode-1",
        playhead_ms=100_000,
        duration_ms=600_000,
        is_playing=True,
        playback_rate=1.0,
        timeline_epoch=0,
        snapshot_seq=1,
        captured_at="2026-01-01T00:00:00Z",
    )


class ContextEnvelopeTest(unittest.TestCase):
    def test_splits_visible_reply_and_scheduled_future_windows(self) -> None:
        chunks = [
            chunk("old", 10_000, 20_000, "An old clue appears."),
            chunk("current", 90_000, 105_000, "The group studies a map."),
            chunk("arrival", 112_000, 122_000, "A route begins to glow."),
            chunk("scheduled", 150_000, 165_000, "A warning alarm sounds."),
            chunk("too-far", 230_000, 240_000, "This is outside the allowed window."),
            chunk(
                "other-epoch",
                95_000,
                102_000,
                "This belongs to a stale timeline.",
                timeline_epoch=1,
            ),
        ]
        result = build_context_envelope(
            session_id="watch_demo",
            snapshot=playback(),
            mode=SessionMode(
                knowledge_mode=KnowledgeMode.NEEDS_SUMMARY,
                reply_lead_ms=30_000,
            ),
            chunks=chunks,
            related_watched_chunks=(chunks[0],),
            story_background="The group is looking for an exit.",
        )

        self.assertEqual([item.chunk_id for item in result.current_chunks], ["current"])
        self.assertEqual([item.chunk_id for item in result.reply_arrival_chunks], ["arrival"])
        self.assertEqual(
            [item.chunk_id for item in result.scheduled_future_chunks],
            ["scheduled"],
        )
        self.assertEqual(
            [item.chunk_id for item in result.related_watched_chunks],
            ["old"],
        )
        self.assertEqual(result.reply_arrival_until_ms, 130_000)

    def test_known_mode_removes_story_background_at_source(self) -> None:
        result = build_context_envelope(
            session_id="watch_demo",
            snapshot=playback(),
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            chunks=(),
            story_background="This must not be injected.",
        )

        self.assertEqual(result.story_background, "")

    def test_json_style_mode_strings_are_normalized_before_context_rules(self) -> None:
        mode = SessionMode(knowledge_mode="known")

        result = build_context_envelope(
            session_id="watch_demo",
            snapshot=playback(),
            mode=mode,
            chunks=(),
            story_background="This must still be removed.",
        )

        self.assertIs(mode.knowledge_mode, KnowledgeMode.KNOWN)
        self.assertEqual(result.story_background, "")

    def test_related_chunks_must_be_fully_watched_and_in_current_epoch(self) -> None:
        valid = chunk("valid", 10_000, 20_000, "A fully watched clue.")
        future = chunk("future", 110_000, 120_000, "Not watched yet.")
        stale = chunk(
            "stale",
            10_000,
            20_000,
            "Old timeline.",
            timeline_epoch=2,
        )

        result = build_context_envelope(
            session_id="watch_demo",
            snapshot=playback(),
            mode=SessionMode(knowledge_mode=KnowledgeMode.NEEDS_SUMMARY),
            chunks=(valid, future, stale),
            related_watched_chunks=(valid, future, stale),
        )

        self.assertEqual(result.related_watched_chunks, (valid,))


class Bm25PlotRecallTest(unittest.TestCase):
    def test_character_name_only_query_returns_at_most_one_chunk(self) -> None:
        recall = Bm25PlotRecall(limit=4)
        chunks = [
            chunk("a", 10_000, 20_000, "Someone opens a window.", characters=("Alice",)),
            chunk("b", 30_000, 40_000, "Someone checks a map.", characters=("Alice",)),
            chunk("c", 50_000, 60_000, "Someone closes a door.", characters=("Alice",)),
        ]

        result = recall.recall("Alice", chunks)

        self.assertEqual(len(result), 1)

    def test_event_terms_outweigh_repeated_character_name(self) -> None:
        recall = Bm25PlotRecall(limit=4)
        relevant = chunk(
            "red-key",
            10_000,
            20_000,
            "Alice hides the red key under a broken clock.",
            characters=("Alice",),
        )
        noise = chunk(
            "map",
            30_000,
            40_000,
            "Alice studies a map beside the window.",
            characters=("Alice",),
        )

        result = recall.recall("Was Alice's red key under the clock?", [noise, relevant])

        self.assertEqual(result[0], relevant)


if __name__ == "__main__":
    unittest.main()
