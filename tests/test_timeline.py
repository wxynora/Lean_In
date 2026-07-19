from __future__ import annotations

import unittest

from together_watch import (
    PlaybackSnapshot,
    TimelineTracker,
    reply_arrival_until_ms,
)


def snapshot(
    *,
    playhead_ms: int = 100_000,
    is_playing: bool = True,
    playback_rate: float = 1.0,
    timeline_epoch: int = 0,
    snapshot_seq: int = 1,
    duration_ms: int = 600_000,
) -> PlaybackSnapshot:
    return PlaybackSnapshot(
        media_id="demo:episode-1",
        playhead_ms=playhead_ms,
        duration_ms=duration_ms,
        is_playing=is_playing,
        playback_rate=playback_rate,
        timeline_epoch=timeline_epoch,
        snapshot_seq=snapshot_seq,
        captured_at="2026-01-01T00:00:00Z",
    )


class TimelineTrackerTest(unittest.TestCase):
    def test_rejects_non_monotonic_sequence_in_same_epoch(self) -> None:
        tracker = TimelineTracker("demo:episode-1")
        self.assertTrue(tracker.apply(snapshot(snapshot_seq=2)).applied)

        result = tracker.apply(snapshot(snapshot_seq=2, playhead_ms=110_000))

        self.assertFalse(result.applied)
        self.assertEqual(result.reason, "non_monotonic_snapshot_seq")
        self.assertEqual(tracker.snapshot.playhead_ms, 100_000)

    def test_new_epoch_replaces_state_and_old_epoch_stays_rejected(self) -> None:
        tracker = TimelineTracker("demo:episode-1")
        tracker.apply(snapshot(timeline_epoch=2, snapshot_seq=9))
        result = tracker.apply(
            snapshot(timeline_epoch=3, snapshot_seq=1, playhead_ms=40_000)
        )
        stale = tracker.apply(
            snapshot(timeline_epoch=2, snapshot_seq=10, playhead_ms=120_000)
        )

        self.assertTrue(result.applied)
        self.assertFalse(stale.applied)
        self.assertEqual(stale.reason, "stale_timeline_epoch")
        self.assertEqual(tracker.snapshot.timeline_epoch, 3)
        self.assertEqual(tracker.snapshot.playhead_ms, 40_000)

    def test_rejects_another_media(self) -> None:
        tracker = TimelineTracker("demo:episode-1")
        other = PlaybackSnapshot(
            media_id="demo:episode-2",
            playhead_ms=10_000,
            duration_ms=600_000,
            is_playing=True,
            playback_rate=1.0,
            timeline_epoch=0,
            snapshot_seq=1,
            captured_at="2026-01-01T00:00:00Z",
        )

        result = tracker.apply(other)

        self.assertFalse(result.applied)
        self.assertEqual(result.reason, "media_mismatch")


class ReplyArrivalWindowTest(unittest.TestCase):
    def test_scales_by_playback_rate_but_never_exceeds_two_media_minutes(self) -> None:
        result = reply_arrival_until_ms(
            snapshot(playback_rate=2.0),
            90_000,
        )

        self.assertEqual(result, 220_000)

    def test_paused_playback_has_no_future_reply_window(self) -> None:
        result = reply_arrival_until_ms(snapshot(is_playing=False), 90_000)

        self.assertEqual(result, 100_000)

    def test_window_stops_at_media_duration(self) -> None:
        result = reply_arrival_until_ms(
            snapshot(playhead_ms=590_000, duration_ms=600_000),
            30_000,
        )

        self.assertEqual(result, 600_000)


if __name__ == "__main__":
    unittest.main()
