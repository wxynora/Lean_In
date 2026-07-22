from __future__ import annotations

import unittest

from together_watch import (
    MediaDescriptor,
    PlaybackSnapshot,
    ViewingExitAction,
    ViewingError,
    ViewingFrame,
    ViewingFrameCapture,
    ViewingLedger,
)


def snapshot(
    *,
    media_id: str,
    playhead_ms: int,
    is_playing: bool,
    playback_rate: float,
    timeline_epoch: int,
    snapshot_seq: int,
    duration_ms: int,
) -> PlaybackSnapshot:
    return PlaybackSnapshot(
        media_id=media_id,
        playhead_ms=playhead_ms,
        duration_ms=duration_ms,
        is_playing=is_playing,
        playback_rate=playback_rate,
        timeline_epoch=timeline_epoch,
        snapshot_seq=snapshot_seq,
        captured_at="2026-07-22T00:00:00Z",
    )


class ViewingLedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.ledger = ViewingLedger()

    @staticmethod
    def media(part_index: int) -> MediaDescriptor:
        return MediaDescriptor(
            media_id=f"demo:movie:p{part_index}",
            source="embedded",
            title="Two-Part Movie",
            duration_ms=600_000 if part_index == 1 else 120_000,
            content_end_ms=300_000 if part_index == 1 else 100_000,
            work_key="movie:two-parts",
            part_key=f"p{part_index}",
            part_index=part_index,
            part_count=2,
            part_title=f"Part {part_index}",
        )

    def test_trusted_duration_cross_part_completion_and_ticket_shelf(self) -> None:
        first = self.ledger.register_session(
            session_id="session-p1",
            media=self.media(1),
            observed_at_ms=0,
            companion_id="companion",
            companion_name="Assistant",
        )
        viewing_id = first.viewing_id
        self.ledger.unlock_session("session-p1")
        self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=0,
                is_playing=True,
                playback_rate=2.0,
                timeline_epoch=0,
                snapshot_seq=1,
                duration_ms=600_000,
            ),
            observed_at_ms=1_000,
        )
        paused = self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=60_000,
                is_playing=False,
                playback_rate=2.0,
                timeline_epoch=0,
                snapshot_seq=2,
                duration_ms=600_000,
            ),
            observed_at_ms=31_000,
        )
        self.assertEqual(paused.summary.played_duration_ms, 30_000)
        paused_again = self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=60_000,
                is_playing=False,
                playback_rate=2.0,
                timeline_epoch=0,
                snapshot_seq=3,
                duration_ms=600_000,
            ),
            observed_at_ms=91_000,
        )
        self.assertEqual(paused_again.summary.played_duration_ms, 30_000)
        self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=60_000,
                is_playing=True,
                playback_rate=1.0,
                timeline_epoch=0,
                snapshot_seq=4,
                duration_ms=600_000,
            ),
            observed_at_ms=101_000,
        )
        after_seek = self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=290_000,
                is_playing=True,
                playback_rate=1.0,
                timeline_epoch=1,
                snapshot_seq=1,
                duration_ms=600_000,
            ),
            observed_at_ms=111_000,
        )
        self.assertEqual(after_seek.summary.played_duration_ms, 30_000)
        first_complete = self.ledger.observe_playback(
            "session-p1",
            snapshot(
                media_id="demo:movie:p1",
                playhead_ms=300_000,
                is_playing=False,
                playback_rate=1.0,
                timeline_epoch=1,
                snapshot_seq=2,
                duration_ms=600_000,
            ),
            observed_at_ms=121_000,
        )
        self.assertTrue(first_complete.part_completed)
        self.assertFalse(first_complete.viewing_completed)
        self.assertEqual(first_complete.summary.played_duration_ms, 40_000)
        self.assertIsNone(first_complete.summary.ticket)

        ended_first = self.ledger.end_session("session-p1", observed_at_ms=122_000)
        self.assertFalse(ended_first.completed)
        self.assertIsNone(ended_first.ticket)

        second = self.ledger.register_session(
            session_id="session-p2",
            media=self.media(2),
            observed_at_ms=130_000,
            viewing_id=viewing_id,
            companion_id="companion",
            companion_name="Assistant",
        )
        self.assertEqual(second.viewing_id, viewing_id)
        self.ledger.unlock_session("session-p2")
        self.ledger.observe_playback(
            "session-p2",
            snapshot(
                media_id="demo:movie:p2",
                playhead_ms=0,
                is_playing=True,
                playback_rate=4.0,
                timeline_epoch=0,
                snapshot_seq=1,
                duration_ms=120_000,
            ),
            observed_at_ms=131_000,
        )
        final = self.ledger.observe_playback(
            "session-p2",
            snapshot(
                media_id="demo:movie:p2",
                playhead_ms=100_000,
                is_playing=False,
                playback_rate=4.0,
                timeline_epoch=0,
                snapshot_seq=2,
                duration_ms=120_000,
            ),
            observed_at_ms=156_000,
            media_ended=True,
        )
        self.assertTrue(final.viewing_completed)
        self.assertEqual(final.summary.played_duration_ms, 65_000)
        self.assertIsNone(final.summary.ticket)

        ended = self.ledger.end_session(
            "session-p2",
            observed_at_ms=157_000,
            action=ViewingExitAction.COMPLETE,
        )
        self.assertTrue(ended.completed)
        self.assertIsNotNone(ended.ticket)
        ticket = ended.ticket
        assert ticket is not None
        self.assertEqual(ticket.played_duration_ms, 65_000)
        self.assertEqual(len(ticket.completed_parts), 2)

        ended_again = self.ledger.end_session("session-p2", observed_at_ms=158_000)
        self.assertEqual(ended.ticket, ticket)
        self.assertEqual(ended_again.ticket, ticket)
        self.assertEqual(self.ledger.list_tickets(), (ticket,))

        renamed = self.ledger.update_ticket_title(
            ticket.ticket_id,
            title="Edited Movie Title",
            observed_at_ms=159_000,
        )
        self.assertEqual(renamed.title, "Edited Movie Title")
        self.assertEqual(self.ledger.list_tickets()[0].title, "Edited Movie Title")

    def test_explicit_media_end_uses_content_end_or_duration(self) -> None:
        media = MediaDescriptor(
            media_id="demo:single",
            source="html5",
            title="Single Movie",
            duration_ms=120_000,
            content_end_ms=100_000,
        )
        summary = self.ledger.register_session(
            session_id="single",
            media=media,
            observed_at_ms=0,
        )
        self.ledger.unlock_session("single")
        result = self.ledger.observe_playback(
            "single",
            snapshot(
                media_id="demo:single",
                playhead_ms=100_000,
                is_playing=False,
                playback_rate=1.0,
                timeline_epoch=0,
                snapshot_seq=1,
                duration_ms=120_000,
            ),
            observed_at_ms=100_000,
            media_ended=True,
        )
        self.assertNotEqual(summary.viewing_id, "")
        self.assertTrue(result.viewing_completed)
        self.assertIsNone(result.summary.ticket)

    def test_explicit_viewing_end_creates_ticket_without_marking_work_complete(self) -> None:
        media = MediaDescriptor(
            media_id="demo:unfinished",
            source="html5",
            title="Unfinished Movie",
            duration_ms=120_000,
        )
        self.ledger.register_session(
            session_id="unfinished",
            media=media,
            observed_at_ms=0,
        )
        ended = self.ledger.end_session(
            "unfinished",
            observed_at_ms=1_000,
            action=ViewingExitAction.COMPLETE,
        )
        self.assertFalse(ended.completed)
        self.assertIsNotNone(ended.ticket)
        self.assertEqual(ended.ticket.played_duration_ms, 0)
        self.assertEqual(self.ledger.list_tickets(), (ended.ticket,))

    def test_internal_session_cleanup_does_not_create_ticket(self) -> None:
        media = MediaDescriptor(
            media_id="demo:part-switch",
            source="html5",
            title="Part Switch",
            duration_ms=120_000,
        )
        self.ledger.register_session(
            session_id="part-switch",
            media=media,
            observed_at_ms=0,
        )

        ended = self.ledger.end_session("part-switch", observed_at_ms=1_000)

        self.assertFalse(ended.completed)
        self.assertIsNone(ended.ticket)
        self.assertEqual(self.ledger.list_tickets(), ())

    def test_save_progress_retains_resume_point_analysis_and_selected_frame(self) -> None:
        media = MediaDescriptor(
            media_id="demo:resume",
            source="bilibili_embed",
            title="Resume Movie",
            duration_ms=600_000,
            work_key="movie:resume",
            part_key="resume:p1",
        )
        first = self.ledger.register_session(
            session_id="resume-first",
            media=media,
            source_reference="https://www.bilibili.com/video/BVresume?p=1",
            observed_at_ms=0,
        )
        self.ledger.unlock_session("resume-first")
        self.ledger.observe_playback(
            "resume-first",
            snapshot(
                media_id=media.media_id,
                playhead_ms=125_000,
                is_playing=False,
                playback_rate=1.0,
                timeline_epoch=0,
                snapshot_seq=1,
                duration_ms=media.duration_ms,
            ),
            observed_at_ms=125_000,
        )
        frame = ViewingFrame(
            frame_id="frame-125",
            media_id=media.media_id,
            at_ms=125_000,
            image_url="https://gateway.example/watch-frames/frame-125.jpg",
            selected_at="2026-07-22T00:02:05Z",
        )
        self.ledger.select_ticket_frame(
            first.viewing_id,
            frame,
            observed_at_ms=125_500,
        )

        saved = self.ledger.end_session(
            "resume-first",
            observed_at_ms=126_000,
            action=ViewingExitAction.SAVE_PROGRESS,
            analysis_covered_until_ms=300_000,
        )

        self.assertIsNone(saved.ticket)
        self.assertIsNotNone(saved.progress)
        assert saved.progress is not None
        self.assertEqual(saved.progress.playhead_ms, 125_000)
        self.assertEqual(saved.progress.played_duration_ms, 0)
        self.assertEqual(saved.progress.analysis_covered_until_ms, 300_000)
        self.assertTrue(saved.progress.analysis_retained)
        self.assertEqual(saved.completed_analysis_cache_expires_at, "")
        self.assertEqual(saved.progress.ticket_back_frame, frame)
        self.assertEqual(self.ledger.list_resumable(), (saved.progress,))

        cleared = self.ledger.clear_ticket_frame(
            first.viewing_id,
            observed_at_ms=127_000,
        )
        self.assertIsNone(cleared.progress.ticket_back_frame)
        self.ledger.select_ticket_frame(
            first.viewing_id,
            frame,
            observed_at_ms=128_000,
        )

        resumed = self.ledger.register_session(
            session_id="resume-second",
            media=media,
            viewing_id=first.viewing_id,
            source_reference=saved.progress.source_reference,
            observed_at_ms=130_000,
        )
        self.assertEqual(resumed.viewing_id, first.viewing_id)
        self.assertIsNone(resumed.progress)
        self.assertEqual(self.ledger.list_resumable(), ())

        completed = self.ledger.end_session(
            "resume-second",
            observed_at_ms=140_000,
            action=ViewingExitAction.COMPLETE,
        )
        self.assertIsNotNone(completed.ticket)
        self.assertEqual(completed.ticket.back_frame, frame)
        self.assertEqual(
            completed.completed_analysis_cache_expires_at,
            "1970-01-02T00:02:20.000Z",
        )

    def test_completed_analysis_ttl_is_configurable_and_does_not_affect_saved_progress(self) -> None:
        ledger = ViewingLedger(completed_analysis_ttl_seconds=3_600)
        media = MediaDescriptor(
            media_id="demo:ttl",
            source="html5",
            title="TTL Movie",
            duration_ms=120_000,
        )
        saved_summary = ledger.register_session(
            session_id="ttl-saved",
            media=media,
            observed_at_ms=0,
        )
        saved = ledger.end_session(
            "ttl-saved",
            observed_at_ms=1_000,
            action=ViewingExitAction.SAVE_PROGRESS,
            analysis_covered_until_ms=60_000,
        )
        self.assertTrue(saved.progress.analysis_retained)
        self.assertEqual(saved.completed_analysis_cache_expires_at, "")

        ledger.register_session(
            session_id="ttl-complete",
            media=media,
            viewing_id=saved_summary.viewing_id,
            observed_at_ms=2_000,
        )
        completed = ledger.end_session(
            "ttl-complete",
            observed_at_ms=3_000,
            action=ViewingExitAction.COMPLETE,
        )
        self.assertIsNone(completed.progress)
        self.assertEqual(
            completed.completed_analysis_cache_expires_at,
            "1970-01-01T01:00:03.000Z",
        )

    def test_ticket_captures_survive_session_end_and_can_be_reselected_after_completion(self) -> None:
        first = self.ledger.register_session(
            session_id="capture-p1",
            media=self.media(1),
            observed_at_ms=0,
        )
        first_capture = self.ledger.save_ticket_frame_capture(
            first.viewing_id,
            session_id="capture-p1",
            media_id="demo:movie:p1",
            timeline_epoch=0,
            at_ms=45_000,
            width=1280,
            height=720,
            mime_type="image/jpeg",
            image_url="https://host.example/capture-p1.jpg",
            observed_at_ms=1_000,
            frame_id="capture-p1-45",
        )
        self.assertIsInstance(first_capture, ViewingFrameCapture)
        saved = self.ledger.end_session(
            "capture-p1",
            observed_at_ms=2_000,
            action=ViewingExitAction.SAVE_PROGRESS,
        )
        self.assertIsNotNone(saved.progress)

        self.ledger.register_session(
            session_id="capture-p2",
            media=self.media(2),
            viewing_id=first.viewing_id,
            observed_at_ms=3_000,
        )
        second_capture = self.ledger.save_ticket_frame_capture(
            first.viewing_id,
            session_id="capture-p2",
            media_id="demo:movie:p2",
            timeline_epoch=0,
            at_ms=15_000,
            width=1280,
            height=720,
            mime_type="image/jpeg",
            image_url="https://host.example/capture-p2.jpg",
            observed_at_ms=4_000,
            frame_id="capture-p2-15",
        )
        completed = self.ledger.end_session(
            "capture-p2",
            observed_at_ms=5_000,
            action=ViewingExitAction.COMPLETE,
        )
        self.assertIsNotNone(completed.ticket)
        self.assertEqual(
            self.ledger.list_ticket_frame_captures(first.viewing_id),
            (first_capture, second_capture),
        )

        selected = self.ledger.select_ticket_frame_capture(
            first.viewing_id,
            first_capture.frame_id,
            observed_at_ms=6_000,
        )
        self.assertEqual(selected.ticket.back_frame.frame_id, first_capture.frame_id)
        cleared = self.ledger.clear_ticket_frame(
            first.viewing_id,
            observed_at_ms=7_000,
        )
        self.assertIsNone(cleared.ticket.back_frame)
        self.assertEqual(
            self.ledger.list_ticket_frame_captures(first.viewing_id),
            (first_capture, second_capture),
        )

    def test_ticket_capture_rejects_wrong_media_and_stale_epoch(self) -> None:
        summary = self.ledger.register_session(
            session_id="capture-validation",
            media=self.media(1),
            observed_at_ms=0,
        )
        with self.assertRaisesRegex(ViewingError, "another media"):
            self.ledger.save_ticket_frame_capture(
                summary.viewing_id,
                session_id="capture-validation",
                media_id="demo:other",
                timeline_epoch=0,
                at_ms=1_000,
                width=1280,
                height=720,
                mime_type="image/jpeg",
                image_url="https://host.example/wrong.jpg",
                observed_at_ms=1_000,
            )
        with self.assertRaisesRegex(ViewingError, "stale timeline"):
            self.ledger.save_ticket_frame_capture(
                summary.viewing_id,
                session_id="capture-validation",
                media_id="demo:movie:p1",
                timeline_epoch=1,
                at_ms=1_000,
                width=1280,
                height=720,
                mime_type="image/jpeg",
                image_url="https://host.example/stale.jpg",
                observed_at_ms=1_000,
            )

    def test_cleanup_does_not_replace_existing_saved_progress(self) -> None:
        media = MediaDescriptor(
            media_id="demo:saved",
            source="html5",
            title="Saved Movie",
            duration_ms=120_000,
        )
        first = self.ledger.register_session(
            session_id="saved-first",
            media=media,
            observed_at_ms=0,
        )
        saved = self.ledger.end_session(
            "saved-first",
            observed_at_ms=1_000,
            action=ViewingExitAction.SAVE_PROGRESS,
        )
        assert saved.progress is not None

        self.ledger.end_session("saved-first", observed_at_ms=2_000)

        self.assertEqual(self.ledger.list_resumable(), (saved.progress,))

    def test_viewing_id_cannot_join_another_work(self) -> None:
        first = self.ledger.register_session(
            session_id="first",
            media=MediaDescriptor(
                media_id="demo:first",
                source="html5",
                title="First",
                duration_ms=10_000,
            ),
            observed_at_ms=0,
        )
        with self.assertRaisesRegex(ViewingError, "another work"):
            self.ledger.register_session(
                session_id="second",
                media=MediaDescriptor(
                    media_id="demo:second",
                    source="html5",
                    title="Second",
                    duration_ms=10_000,
                ),
                observed_at_ms=1_000,
                viewing_id=first.viewing_id,
            )


if __name__ == "__main__":
    unittest.main()
