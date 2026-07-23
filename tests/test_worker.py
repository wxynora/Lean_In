from __future__ import annotations

import unittest
from collections.abc import Mapping, Sequence
from typing import Any

from together_watch import (
    AnalysisWorker,
    AnalysisWorkSpec,
    KnowledgeMode,
    SampleManager,
    SamplePlan,
    SamplePurpose,
    StructuredProviderResult,
    WorkerClaim,
    WorkerProviderError,
    WorkerRunStatus,
)


class FakeRuntime:
    def __init__(self) -> None:
        self.claim = WorkerClaim(
            work_id="analysis-1",
            session_id="watch-1",
            lease_token="lease-1",
        )
        self.guard_reasons: dict[str, str] = {}
        self.commit_reason = ""
        self.events: list[str] = []
        self.usage: list[tuple[str, Mapping[str, Any]]] = []
        self.committed_payload: Mapping[str, Any] | None = None
        self.cancelled_reason = ""
        self.failed: tuple[str, bool] | None = None
        self.spec = AnalysisWorkSpec(
            purpose=SamplePurpose.ROLLING,
            knowledge_mode=KnowledgeMode.KNOWN,
            context={
                "media": {"id": "movie:1", "duration_ms": 600_000},
                "range": {"start_ms": 0, "end_ms": 140_000},
                "samples": [],
            },
            sample_plan=SamplePlan(
                plan_id="plan-1",
                session_id="watch-1",
                media_id="movie:1",
                timeline_epoch=0,
                purpose=SamplePurpose.ROLLING,
                managed_by=SampleManager.GATEWAY,
                start_ms=0,
                end_ms=140_000,
                max_frames=8,
                audio_required=True,
            ),
        )

    def claim_next(self, *, now_ms: int) -> WorkerClaim | None:
        self.events.append("claim")
        return self.claim

    def guard_work(
        self,
        claim: WorkerClaim,
        *,
        checkpoint: str,
        now_ms: int,
    ) -> str:
        self.events.append(f"guard:{checkpoint}")
        return self.guard_reasons.get(checkpoint, "")

    def load_work_spec(self, claim: WorkerClaim) -> AnalysisWorkSpec:
        self.events.append("load_spec")
        return self.spec

    def load_media_parts(
        self,
        claim: WorkerClaim,
        spec: AnalysisWorkSpec,
    ) -> Sequence[Mapping[str, Any]]:
        self.events.append("load_media")
        return ({"kind": "image", "at_ms": 30_000},)

    def record_provider_usage(
        self,
        claim: WorkerClaim,
        *,
        event_key: str,
        usage: Mapping[str, Any],
    ) -> None:
        self.events.append("record_usage")
        self.usage.append((event_key, usage))

    def commit_result(
        self,
        claim: WorkerClaim,
        *,
        payload: Mapping[str, Any],
        now_ms: int,
    ) -> str:
        self.events.append("commit")
        if not self.commit_reason:
            self.committed_payload = payload
        return self.commit_reason

    def cancel_work(self, claim: WorkerClaim, *, reason: str) -> None:
        self.events.append("cancel")
        self.cancelled_reason = reason

    def fail_work(
        self,
        claim: WorkerClaim,
        *,
        reason: str,
        retryable: bool,
    ) -> None:
        self.events.append("fail")
        self.failed = (reason, retryable)

    def release_samples(self, claim: WorkerClaim) -> None:
        self.events.append("release")


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0
        self.error: WorkerProviderError | None = None

    def generate(self, prompt, *, media_parts, options):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return StructuredProviderResult(
            payload={
                "plot_chunks": [],
                "risk_events": [],
                "timeline": {},
            },
            usage={
                "provider_called": True,
                "input_tokens": 100,
                "output_tokens": 50,
            },
        )


class AnalysisWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = FakeRuntime()
        self.model = FakeModel()
        self.clock = 1_000
        self.worker = AnalysisWorker(
            runtime=self.runtime,
            model=self.model,
            now_ms=lambda: self.clock,
        )

    def test_success_checks_each_boundary_and_commits_once(self) -> None:
        result = self.worker.run_once()

        self.assertEqual(result.status, WorkerRunStatus.COMPLETED)
        self.assertTrue(result.provider_called)
        self.assertEqual(self.model.calls, 1)
        self.assertEqual(self.runtime.usage[0][0], "analysis-1:provider")
        self.assertEqual(
            self.runtime.events,
            [
                "claim",
                "guard:after_claim",
                "load_spec",
                "guard:before_sampling",
                "load_media",
                "guard:before_provider",
                "record_usage",
                "guard:before_commit",
                "commit",
                "release",
            ],
        )

    def test_cancellation_after_sampling_prevents_provider_call(self) -> None:
        self.runtime.guard_reasons["before_provider"] = "stale_timeline"

        result = self.worker.run_once()

        self.assertEqual(result.status, WorkerRunStatus.CANCELLED)
        self.assertEqual(result.reason, "stale_timeline")
        self.assertEqual(self.model.calls, 0)
        self.assertEqual(self.runtime.cancelled_reason, "stale_timeline")
        self.assertEqual(self.runtime.events[-2:], ["cancel", "release"])

    def test_provider_usage_is_recorded_before_cancelled_commit(self) -> None:
        self.runtime.guard_reasons["before_commit"] = "session_ended"

        result = self.worker.run_once()

        self.assertEqual(result.status, WorkerRunStatus.CANCELLED)
        self.assertTrue(result.provider_called)
        self.assertEqual(len(self.runtime.usage), 1)
        self.assertIsNone(self.runtime.committed_payload)
        self.assertLess(
            self.runtime.events.index("record_usage"),
            self.runtime.events.index("guard:before_commit"),
        )

    def test_provider_failure_preserves_usage_and_retry_decision(self) -> None:
        self.model.error = WorkerProviderError(
            "bad structured response",
            code="json_invalid",
            retryable=True,
            usage={"provider_called": True, "input_tokens": 200},
        )

        result = self.worker.run_once()

        self.assertEqual(result.status, WorkerRunStatus.FAILED)
        self.assertEqual(result.reason, "json_invalid")
        self.assertTrue(result.provider_called)
        self.assertEqual(self.runtime.failed, ("json_invalid", True))
        self.assertEqual(len(self.runtime.usage), 1)
        self.assertEqual(self.runtime.events[-2:], ["fail", "release"])

    def test_atomic_commit_rejection_cancels_stale_result(self) -> None:
        self.runtime.commit_reason = "lease_lost"

        result = self.worker.run_once()

        self.assertEqual(result.status, WorkerRunStatus.CANCELLED)
        self.assertEqual(result.reason, "lease_lost")
        self.assertTrue(result.provider_called)
        self.assertIsNone(self.runtime.committed_payload)
        self.assertEqual(self.runtime.cancelled_reason, "lease_lost")
        self.assertEqual(self.runtime.events[-3:], ["commit", "cancel", "release"])


if __name__ == "__main__":
    unittest.main()
