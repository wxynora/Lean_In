from __future__ import annotations

import unittest

from together_watch import (
    PlaybackSnapshot,
    ReplyLatencyTracker,
    TimelineTracker,
    advance_through_cached_intervals,
    cached_interval_at,
    merge_cached_intervals,
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
    def test_cached_media_intervals_survive_epoch_changes(self) -> None:
        merged = merge_cached_intervals(((30_000, 100_000), (100_500, 170_000)))

        self.assertEqual(merged, ((30_000, 170_000),))
        self.assertEqual(cached_interval_at(merged, 80_000), (30_000, 170_000))
        self.assertEqual(advance_through_cached_intervals(merged, 80_000), 170_000)

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


class ReplyLatencyTrackerTest(unittest.TestCase):
    def test_client_display_replaces_gateway_sample_for_the_same_job(self) -> None:
        tracker = ReplyLatencyTracker()
        tracker.record(
            session_id="watch-1",
            job_id="job-1",
            latency_ms=8_000,
        )
        tracker.record(
            session_id="watch-1",
            job_id="job-2",
            latency_ms=12_000,
        )

        profile = tracker.record(
            session_id="watch-1",
            job_id="job-1",
            latency_ms=10_000,
            source="client_displayed",
        )

        self.assertEqual(profile.sample_count, 2)
        self.assertEqual(profile.average_latency_ms, 11_000)
        self.assertEqual(profile.latest_source, "client_displayed")


if __name__ == "__main__":
    unittest.main()
