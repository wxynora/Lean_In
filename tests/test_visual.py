from __future__ import annotations

import unittest

from together_watch import (
    ContextEnvelope,
    PlotChunk,
    VisualFrame,
    select_contact_sheet_panels,
)


def chunk(chunk_id: str, start_ms: int, end_ms: int) -> PlotChunk:
    return PlotChunk(
        chunk_id=chunk_id,
        session_id="watch-1",
        timeline_epoch=2,
        start_ms=start_ms,
        end_ms=end_ms,
        summary=chunk_id,
    )


class VisualPanelSelectionTest(unittest.TestCase):
    def test_selects_current_related_and_arrival_frames_without_duplicates(self) -> None:
        current = chunk("current", 35_000, 45_000)
        related = chunk("related", 5_000, 15_000)
        arrival = chunk("arrival", 60_000, 80_000)
        envelope = ContextEnvelope(
            session_id="watch-1",
            media_id="media-1",
            message_playhead_ms=40_000,
            reply_arrival_until_ms=100_000,
            story_background="",
            related_watched_chunks=(related,),
            current_chunks=(current,),
            reply_arrival_chunks=(arrival,),
            scheduled_future_chunks=(),
            timeline_epoch=2,
            visual_related_chunk_id="related",
        )
        frames = tuple(
            VisualFrame(
                frame_id=f"frame-{at_ms}",
                session_id="watch-1",
                media_id="media-1",
                timeline_epoch=2,
                at_ms=at_ms,
            )
            for at_ms in (10_000, 40_000, 70_000, 100_000)
        )

        panels = select_contact_sheet_panels(frames, envelope)

        self.assertEqual(
            [(panel.role, panel.frame.at_ms) for panel in panels],
            [("A", 40_000), ("B", 10_000), ("C", 70_000), ("D", 100_000)],
        )

    def test_rejects_frames_from_another_epoch_or_after_the_visible_boundary(self) -> None:
        envelope = ContextEnvelope(
            session_id="watch-1",
            media_id="media-1",
            message_playhead_ms=40_000,
            reply_arrival_until_ms=70_000,
            story_background="",
            related_watched_chunks=(),
            current_chunks=(),
            reply_arrival_chunks=(),
            scheduled_future_chunks=(),
            timeline_epoch=2,
        )
        frames = (
            VisualFrame("valid", "watch-1", "media-1", 2, 40_000),
            VisualFrame("stale", "watch-1", "media-1", 1, 60_000),
            VisualFrame("future", "watch-1", "media-1", 2, 80_000),
        )

        panels = select_contact_sheet_panels(frames, envelope)

        self.assertEqual({panel.frame.frame_id for panel in panels}, {"valid"})


if __name__ == "__main__":
    unittest.main()
