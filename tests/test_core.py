from __future__ import annotations

import unittest

from together_watch import (
    AudioSelection,
    ClientCapabilities,
    KnowledgeMode,
    LocalMediaDescriptor,
    LocalPlaybackCapabilities,
    MediaDescriptor,
    PlaybackSnapshot,
    PlotChunk,
    RiskEvent,
    SessionMode,
    SubtitleSelection,
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

    def test_session_creation_is_idempotent_for_one_request_key(self) -> None:
        capabilities = ClientCapabilities(playback_snapshot=True)
        first = self.core.create_session(
            media=media(),
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            capabilities=capabilities,
            idempotency_key="create-request-1",
        )
        repeated = self.core.create_session(
            media=media(),
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            capabilities=capabilities,
            idempotency_key="create-request-1",
        )

        self.assertIs(repeated, first)
        with self.assertRaisesRegex(WatchCoreError, "different session data"):
            self.core.create_session(
                media=media(),
                mode=SessionMode(knowledge_mode=KnowledgeMode.NEEDS_SUMMARY),
                capabilities=capabilities,
                idempotency_key="create-request-1",
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

    def test_recorded_reply_latency_changes_the_next_context_window(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(session.session_id, snapshot())
        self.core.add_plot_chunks(
            session.session_id,
            [
                PlotChunk(
                    chunk_id="arrival",
                    session_id=session.session_id,
                    timeline_epoch=0,
                    start_ms=110_000,
                    end_ms=118_000,
                    summary="The door opens.",
                )
            ],
        )
        self.core.record_reply_latency(
            session.session_id,
            job_id="job-1",
            latency_ms=12_000,
            source="client_displayed",
        )

        context = self.core.build_context(session.session_id)

        self.assertEqual(context.reply_arrival_until_ms, 112_000)
        self.assertEqual(context.reply_arrival_chunks[0].chunk_id, "arrival")
        self.assertEqual(context.reply_latency.latest_source, "client_displayed")

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

    def test_seek_reuses_completed_media_time_results_and_coverage(self) -> None:
        session = self.create_session()
        self.core.start_session(session.session_id)
        self.core.apply_snapshot(
            session.session_id,
            snapshot(epoch=0, seq=1, playhead_ms=30_000),
        )
        self.core.add_plot_chunks(
            session.session_id,
            [
                PlotChunk(
                    chunk_id="plot-paid",
                    session_id=session.session_id,
                    timeline_epoch=0,
                    start_ms=20_000,
                    end_ms=120_000,
                    summary="This range was already analyzed.",
                )
            ],
        )
        self.core.add_risk_events(
            session.session_id,
            [
                RiskEvent(
                    risk_id="risk-paid",
                    session_id=session.session_id,
                    timeline_epoch=0,
                    warn_at_ms=70_000,
                    start_ms=75_000,
                    end_ms=80_000,
                    severity=0.8,
                )
            ],
        )
        self.core.record_analysis_coverage(
            session.session_id,
            start_ms=0,
            end_ms=140_000,
        )

        applied = self.core.apply_snapshot(
            session.session_id,
            snapshot(epoch=1, seq=1, playhead_ms=30_000),
        )
        context = self.core.build_context(session.session_id)
        risks = self.core.upcoming_risks(session.session_id)

        self.assertTrue(applied.applied)
        self.assertEqual(
            self.core.reusable_coverage_at(session.session_id, position_ms=30_000),
            (0, 140_000),
        )
        self.assertEqual(
            self.core.next_uncovered_ms(session.session_id, position_ms=30_000),
            140_000,
        )
        self.assertEqual(context.current_chunks[0].summary, "This range was already analyzed.")
        self.assertEqual(risks[0].timeline_epoch, 1)

    def test_saved_analysis_rejects_a_replaced_local_file(self) -> None:
        capabilities = LocalPlaybackCapabilities(
            can_play=True,
            can_seek=True,
            can_read_future=True,
            can_export_frames=True,
            can_export_audio=False,
            has_audio=False,
            is_drm=False,
        )
        original = MediaDescriptor(
            media_id="local:asset-1",
            source="local_file",
            title="Local movie",
            duration_ms=600_000,
            local_media=LocalMediaDescriptor(
                local_asset_id="asset-1",
                media_revision="revision-1",
                capabilities=capabilities,
            ),
        )
        replacement = MediaDescriptor(
            media_id="local:asset-1",
            source="local_file",
            title="Local movie",
            duration_ms=600_000,
            local_media=LocalMediaDescriptor(
                local_asset_id="asset-1",
                media_revision="revision-2",
                capabilities=capabilities,
            ),
        )
        self.core.create_session(
            session_id="local-original",
            media=original,
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            capabilities=ClientCapabilities(playback_snapshot=True),
        )
        self.core.record_analysis_coverage(
            "local-original",
            start_ms=0,
            end_ms=60_000,
        )
        self.assertEqual(
            self.core.retain_viewing_analysis("viewing-local", "local-original"),
            60_000,
        )
        self.core.create_session(
            session_id="local-replacement",
            media=replacement,
            mode=SessionMode(knowledge_mode=KnowledgeMode.KNOWN),
            capabilities=ClientCapabilities(playback_snapshot=True),
        )

        with self.assertRaisesRegex(WatchCoreError, "another media revision"):
            self.core.restore_viewing_analysis("viewing-local", "local-replacement")


class ClientCapabilitiesTest(unittest.TestCase):
    def test_client_sampling_requires_local_media(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires local_media"):
            ClientCapabilities(
                playback_snapshot=True,
                client_sampling=True,
            )

    def test_local_media_requires_revision_and_selected_audio_track(self) -> None:
        local = LocalMediaDescriptor(
            local_asset_id="asset-1",
            media_revision="revision-1",
            capabilities=LocalPlaybackCapabilities(
                can_play=True,
                can_seek=True,
                can_read_future=True,
                can_export_frames=True,
                can_export_audio=False,
                has_audio=True,
                is_drm=False,
            ),
            selected_audio=AudioSelection(track_id="audio-main", language="ja"),
            selected_subtitle=SubtitleSelection(
                kind="external",
                language="zh-CN",
                label="movie.srt",
                format="srt",
                offset_ms=500,
            ),
        )

        descriptor = MediaDescriptor(
            media_id="local:asset-1",
            source="local_file",
            title="Local movie",
            duration_ms=600_000,
            local_media=local,
        )

        self.assertEqual(descriptor.local_media.media_revision, "revision-1")


if __name__ == "__main__":
    unittest.main()
