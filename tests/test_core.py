from __future__ import annotations

import unittest

from together_watch import (
    ClientCapabilities,
    KnowledgeMode,
    MediaDescriptor,
    PlaybackSnapshot,
    RiskEvent,
    SessionMode,
    WatchCore,
    WatchCoreError,
)


def media() -> MediaDescriptor:
    return MediaDescriptor(
        media_id="demo:episode-1",
        source="html5",
        title="Demo Episode",
        duration_ms=600_000,
    )


def snapshot(*, epoch: int = 0, seq: int = 1, playhead_ms: int = 100_000) -> PlaybackSnapshot:
    return PlaybackSnapshot(
        media_id="demo:episode-1",
        playhead_ms=playhead_ms,
        duration_ms=600_000,
        is_playing=True,
        playback_rate=1.0,
        timeline_epoch=epoch,
        snapshot_seq=seq,
        captured_at="2026-01-01T00:00:00Z",
    )


class WatchCoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.core = WatchCore()

    def create_session(self):
        return self.core.create_session(
            session_id="watch_demo",
            media=media(),
            mode=SessionMode(knowledge_mode=KnowledgeMode.NEEDS_SUMMARY),
            capabilities=ClientCapabilities(
                playback_snapshot=True,
                danmaku_overlay=True,
                risk_overlay=True,
            ),
        )

    def test_playback_snapshot_capability_is_required(self) -> None:
        with self.assertRaisesRegex(WatchCoreError, "playback_snapshot"):
            self.core.create_session(
                media=media(),
                mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
                capabilities=ClientCapabilities(playback_snapshot=False),
            )

    def test_stale_snapshot_does_not_replace_current_session_state(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(session.session_id, snapshot(seq=2))

        result = self.core.apply_snapshot(
            session.session_id,
            snapshot(seq=1, playhead_ms=200_000),
        )

        self.assertFalse(result.applied)
        self.assertEqual(session.snapshot.playhead_ms, 100_000)

    def test_playing_snapshot_is_rejected_before_session_start(self) -> None:
        session = self.create_session()

        result = self.core.apply_snapshot(session.session_id, snapshot())

        self.assertFalse(result.applied)
        self.assertEqual(result.reason, "session_not_started")
        self.assertIsNone(session.snapshot)

    def test_danmaku_is_validated_and_deduplicated(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(session.session_id, snapshot())

        action, validation = self.core.prepare_danmaku(
            session.session_id,
            target_ms=130_000,
            text="That clue finally connects.",
        )
        self.core.consume_action(action)
        duplicate, duplicate_validation = self.core.prepare_danmaku(
            session.session_id,
            target_ms=130_000,
            text="That clue finally connects.",
        )

        self.assertTrue(validation.valid)
        self.assertEqual(action.action_id, duplicate.action_id)
        self.assertFalse(duplicate_validation.valid)
        self.assertEqual(duplicate_validation.reason, "duplicate_action")

    def test_danmaku_outside_two_minute_window_is_rejected(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(session.session_id, snapshot())

        _, validation = self.core.prepare_danmaku(
            session.session_id,
            target_ms=230_000,
            text="Too far ahead.",
        )

        self.assertFalse(validation.valid)
        self.assertEqual(validation.reason, "target_outside_future_window")

    def test_upcoming_risks_ignore_old_epoch(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(session.session_id, snapshot(epoch=2))
        current = RiskEvent(
            risk_id="risk-current",
            session_id=session.session_id,
            timeline_epoch=2,
            warn_at_ms=110_000,
            start_ms=115_000,
            end_ms=120_000,
            severity=0.8,
        )
        stale = RiskEvent(
            risk_id="risk-stale",
            session_id=session.session_id,
            timeline_epoch=1,
            warn_at_ms=105_000,
            start_ms=110_000,
            end_ms=115_000,
            severity=0.8,
        )
        self.core.add_risk_events(session.session_id, [stale, current])

        result = self.core.upcoming_risks(session.session_id)

        self.assertEqual(result, (current,))

class ClientCapabilitiesTest(unittest.TestCase):
    def test_client_sampling_requires_local_media(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires local_media"):
            ClientCapabilities(
                playback_snapshot=True,
                client_sampling=True,
            )


if __name__ == "__main__":
    unittest.main()
