from __future__ import annotations

import unittest

from together_watch import LifecycleError, WorkCoordinator, WorkStatus


class WorkCoordinatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.coordinator = WorkCoordinator(client_lease_ms=90_000)
        self.coordinator.register_session(
            session_id="watch-demo",
            media_id="demo:episode-1",
            timeline_epoch=0,
            now_ms=1_000,
        )

    def test_expired_client_cannot_schedule_or_be_claimed(self) -> None:
        allowed, reason = self.coordinator.schedule_eligibility(
            "watch-demo",
            now_ms=91_001,
        )
        self.assertFalse(allowed)
        self.assertEqual(reason, "client_lease_expired")
        with self.assertRaisesRegex(LifecycleError, "client_lease_expired"):
            self.coordinator.enqueue_work(
                work_id="late",
                session_id="watch-demo",
                purpose="rolling",
                now_ms=91_001,
            )
        self.assertIsNone(self.coordinator.claim_next(now_ms=91_001))
        self.assertTrue(self.coordinator.get_session("watch-demo").ended)

    def test_heartbeat_renews_independent_client_lease(self) -> None:
        runtime = self.coordinator.heartbeat("watch-demo", now_ms=80_000)
        self.assertEqual(runtime.client_seen_at_ms, 80_000)
        self.assertEqual(runtime.client_lease_expires_at_ms, 170_000)
        self.assertEqual(
            self.coordinator.schedule_eligibility("watch-demo", now_ms=100_000),
            (True, ""),
        )

    def test_end_cancels_queued_and_requests_running_cancellation(self) -> None:
        running = self.coordinator.enqueue_work(
            work_id="running",
            session_id="watch-demo",
            purpose="rolling",
            now_ms=2_000,
        )
        queued = self.coordinator.enqueue_work(
            work_id="queued",
            session_id="watch-demo",
            purpose="subtitle_lookup",
            now_ms=2_000,
            epoch_sensitive=False,
        )
        claimed = self.coordinator.claim_next(now_ms=2_000)
        self.assertIs(claimed, running)
        stats = self.coordinator.end_session("watch-demo")

        self.assertEqual(stats, {"queued_cancelled": 1, "running_cancel_requested": 1})
        self.assertEqual(queued.status, WorkStatus.CANCELLED)
        self.assertTrue(running.cancel_requested)
        self.assertEqual(
            self.coordinator.guard_work(running.work_id, claimed.lease_token, now_ms=2_001),
            "cancel_requested",
        )

    def test_model_result_is_not_committed_after_end(self) -> None:
        item = self.coordinator.enqueue_work(
            work_id="model",
            session_id="watch-demo",
            purpose="rolling",
            now_ms=2_000,
        )
        claimed = self.coordinator.claim_next(now_ms=2_000)
        self.coordinator.end_session("watch-demo")

        applied, reason = self.coordinator.complete_work(
            item.work_id,
            claimed.lease_token,
            now_ms=3_000,
            usage={"cost_usd": 1.0},
        )

        self.assertFalse(applied)
        self.assertEqual(reason, "cancel_requested")
        self.assertEqual(item.usage, {})

    def test_wrong_or_reused_worker_lease_cannot_mutate_work(self) -> None:
        item = self.coordinator.enqueue_work(
            work_id="owned",
            session_id="watch-demo",
            purpose="rolling",
            now_ms=2_000,
        )
        claimed = self.coordinator.claim_next(now_ms=2_000)

        applied, reason = self.coordinator.complete_work(
            item.work_id,
            "another-worker",
            now_ms=2_100,
            usage={"cost_usd": 9.0},
        )

        self.assertFalse(applied)
        self.assertEqual(reason, "lease_lost")
        self.assertEqual(item.status, WorkStatus.RUNNING)
        self.assertFalse(item.cancel_requested)
        self.assertEqual(item.usage, {})

        applied, reason = self.coordinator.complete_work(
            item.work_id,
            claimed.lease_token,
            now_ms=2_200,
            usage={"cost_usd": 1.0},
        )
        self.assertTrue(applied)
        self.assertEqual(reason, "")
        self.assertEqual(item.status, WorkStatus.DONE)
        self.assertEqual(item.usage, {"cost_usd": 1.0})

        applied, reason = self.coordinator.complete_work(
            item.work_id,
            claimed.lease_token,
            now_ms=2_300,
            usage={"cost_usd": 2.0},
        )
        self.assertFalse(applied)
        self.assertEqual(reason, "lease_lost")
        self.assertEqual(item.status, WorkStatus.DONE)
        self.assertEqual(item.usage, {"cost_usd": 1.0})

    def test_seek_invalidates_only_epoch_sensitive_work(self) -> None:
        rolling = self.coordinator.enqueue_work(
            work_id="rolling",
            session_id="watch-demo",
            purpose="rolling",
            now_ms=2_000,
        )
        subtitle = self.coordinator.enqueue_work(
            work_id="subtitle",
            session_id="watch-demo",
            purpose="subtitle_lookup",
            now_ms=2_000,
            epoch_sensitive=False,
        )
        self.coordinator.update_timeline(
            "watch-demo",
            media_id="demo:episode-1",
            timeline_epoch=1,
        )

        self.assertEqual(rolling.status, WorkStatus.CANCELLED)
        self.assertEqual(rolling.cancel_reason, "stale_timeline")
        self.assertEqual(subtitle.status, WorkStatus.QUEUED)


if __name__ == "__main__":
    unittest.main()
