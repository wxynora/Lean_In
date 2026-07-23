from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol, runtime_checkable

from .models import KnowledgeMode, SamplePlan, SamplePurpose
from .prompts import PromptBundle, build_analysis_prompt
from .provider_response import StructuredProviderResult


class WorkerRunStatus(str, Enum):
    IDLE = "idle"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class WorkerClaim:
    work_id: str
    session_id: str
    lease_token: str

    def __post_init__(self) -> None:
        for name in ("work_id", "session_id", "lease_token"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")


@dataclass(frozen=True, slots=True)
class AnalysisWorkSpec:
    purpose: SamplePurpose
    knowledge_mode: KnowledgeMode
    context: Mapping[str, Any]
    sample_plan: SamplePlan
    output_language: str = "Chinese"
    model_options: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "purpose", SamplePurpose(self.purpose))
        object.__setattr__(self, "knowledge_mode", KnowledgeMode(self.knowledge_mode))
        if not isinstance(self.context, Mapping):
            raise ValueError("context must be a mapping")
        if not isinstance(self.model_options, Mapping):
            raise ValueError("model_options must be a mapping")
        if not isinstance(self.output_language, str) or not self.output_language.strip():
            raise ValueError("output_language must be a non-empty string")


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    status: WorkerRunStatus
    work_id: str = ""
    reason: str = ""
    provider_called: bool = False


class WorkerProviderError(RuntimeError):
    """A normalized provider failure that the host may retry."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "provider_error",
        retryable: bool = True,
        usage: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = str(code).strip() or "provider_error"
        self.retryable = bool(retryable)
        self.usage = dict(usage or {})


@runtime_checkable
class AnalysisWorkerRuntime(Protocol):
    """Host persistence and queue boundary used by the portable worker."""

    def claim_next(self, *, now_ms: int) -> WorkerClaim | None: ...

    def guard_work(
        self,
        claim: WorkerClaim,
        *,
        checkpoint: str,
        now_ms: int,
    ) -> str: ...

    def load_work_spec(self, claim: WorkerClaim) -> AnalysisWorkSpec: ...

    def load_media_parts(
        self,
        claim: WorkerClaim,
        spec: AnalysisWorkSpec,
    ) -> Sequence[Mapping[str, Any]]: ...

    def record_provider_usage(
        self,
        claim: WorkerClaim,
        *,
        event_key: str,
        usage: Mapping[str, Any],
    ) -> None: ...

    def commit_result(
        self,
        claim: WorkerClaim,
        *,
        payload: Mapping[str, Any],
        now_ms: int,
    ) -> str:
        """Atomically recheck ownership/liveness and commit, or return a skip reason."""
        ...

    def cancel_work(self, claim: WorkerClaim, *, reason: str) -> None: ...

    def fail_work(
        self,
        claim: WorkerClaim,
        *,
        reason: str,
        retryable: bool,
    ) -> None: ...

    def release_samples(self, claim: WorkerClaim) -> None: ...


@runtime_checkable
class AnalysisWorkerModel(Protocol):
    """Normalized model boundary; provider SDK details stay in the host adapter."""

    def generate(
        self,
        prompt: PromptBundle,
        *,
        media_parts: Sequence[Mapping[str, Any]],
        options: Mapping[str, Any],
    ) -> StructuredProviderResult: ...


class AnalysisWorker:
    """Run one claimed analysis task through guarded provider execution."""

    def __init__(
        self,
        *,
        runtime: AnalysisWorkerRuntime,
        model: AnalysisWorkerModel,
        now_ms: Callable[[], int],
    ) -> None:
        self.runtime = runtime
        self.model = model
        self.now_ms = now_ms

    def run_once(self) -> WorkerRunResult:
        claim = self.runtime.claim_next(now_ms=self.now_ms())
        if claim is None:
            return WorkerRunResult(status=WorkerRunStatus.IDLE)

        try:
            cancelled = self._guard_or_cancel(claim, checkpoint="after_claim")
            if cancelled is not None:
                return cancelled

            spec = self.runtime.load_work_spec(claim)
            self._validate_spec(claim, spec)
            cancelled = self._guard_or_cancel(claim, checkpoint="before_sampling")
            if cancelled is not None:
                return cancelled

            media_parts = tuple(self.runtime.load_media_parts(claim, spec))
            cancelled = self._guard_or_cancel(claim, checkpoint="before_provider")
            if cancelled is not None:
                return cancelled

            prompt = build_analysis_prompt(
                purpose=spec.purpose.value,
                context=spec.context,
                knowledge_mode=spec.knowledge_mode.value,
                output_language=spec.output_language,
            )
            try:
                result = self.model.generate(
                    prompt,
                    media_parts=media_parts,
                    options=spec.model_options,
                )
            except WorkerProviderError as exc:
                if exc.usage:
                    self._record_usage(claim, exc.usage)
                self.runtime.fail_work(
                    claim,
                    reason=exc.code,
                    retryable=exc.retryable,
                )
                return WorkerRunResult(
                    status=WorkerRunStatus.FAILED,
                    work_id=claim.work_id,
                    reason=exc.code,
                    provider_called=bool(exc.usage),
                )

            if not isinstance(result, StructuredProviderResult):
                raise TypeError("model adapter must return StructuredProviderResult")
            self._record_usage(claim, result.usage)

            cancelled = self._guard_or_cancel(claim, checkpoint="before_commit")
            if cancelled is not None:
                return WorkerRunResult(
                    status=cancelled.status,
                    work_id=cancelled.work_id,
                    reason=cancelled.reason,
                    provider_called=True,
                )

            reason = self.runtime.commit_result(
                claim,
                payload=result.payload,
                now_ms=self.now_ms(),
            )
            if reason:
                self.runtime.cancel_work(claim, reason=reason)
                return WorkerRunResult(
                    status=WorkerRunStatus.CANCELLED,
                    work_id=claim.work_id,
                    reason=reason,
                    provider_called=True,
                )
            return WorkerRunResult(
                status=WorkerRunStatus.COMPLETED,
                work_id=claim.work_id,
                provider_called=True,
            )
        finally:
            self.runtime.release_samples(claim)

    def _guard_or_cancel(
        self,
        claim: WorkerClaim,
        *,
        checkpoint: str,
    ) -> WorkerRunResult | None:
        reason = self.runtime.guard_work(
            claim,
            checkpoint=checkpoint,
            now_ms=self.now_ms(),
        )
        if not reason:
            return None
        self.runtime.cancel_work(claim, reason=reason)
        return WorkerRunResult(
            status=WorkerRunStatus.CANCELLED,
            work_id=claim.work_id,
            reason=reason,
        )

    @staticmethod
    def _validate_spec(claim: WorkerClaim, spec: AnalysisWorkSpec) -> None:
        if spec.sample_plan.session_id != claim.session_id:
            raise ValueError("sample plan belongs to another session")
        if spec.sample_plan.purpose is not spec.purpose:
            raise ValueError("sample plan purpose does not match work purpose")

    def _record_usage(
        self,
        claim: WorkerClaim,
        usage: Mapping[str, Any],
    ) -> None:
        self.runtime.record_provider_usage(
            claim,
            event_key=f"{claim.work_id}:provider",
            usage=usage,
        )
