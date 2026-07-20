from __future__ import annotations

import unittest

from together_watch import evaluate_start_gate


class StartGateTests(unittest.TestCase):
    def test_normal_mode_waits_for_initial_plot_coverage(self) -> None:
        buffering = evaluate_start_gate(
            started=True,
            fear_mode=False,
            playback_unlocked=False,
            explicit_unprotected=True,
            analysis_ready=True,
            playhead_ms=0,
            covered_until_ms=299_999,
            required_buffer_ms=300_000,
            duration_ms=600_000,
        )
        ready = evaluate_start_gate(
            started=True,
            fear_mode=False,
            playback_unlocked=False,
            explicit_unprotected=False,
            analysis_ready=True,
            playhead_ms=0,
            covered_until_ms=300_000,
            required_buffer_ms=300_000,
            duration_ms=600_000,
        )

        self.assertEqual(buffering.status, "buffering")
        self.assertEqual(buffering.reason, "initial_analysis_coverage_pending")
        self.assertFalse(buffering.can_play)
        self.assertFalse(buffering.should_persist_unlock)
        self.assertEqual(ready.status, "ready")
        self.assertTrue(ready.can_play)
        self.assertTrue(ready.should_persist_unlock)

    def test_initial_fear_coverage_atomically_unlocks_playback(self) -> None:
        buffering = evaluate_start_gate(
            started=True,
            fear_mode=True,
            playback_unlocked=False,
            explicit_unprotected=False,
            analysis_ready=False,
            playhead_ms=5_000,
            covered_until_ms=100_000,
            required_buffer_ms=120_000,
            duration_ms=180_000,
        )
        ready = evaluate_start_gate(
            started=True,
            fear_mode=True,
            playback_unlocked=False,
            explicit_unprotected=False,
            analysis_ready=True,
            playhead_ms=5_000,
            covered_until_ms=125_000,
            required_buffer_ms=120_000,
            duration_ms=180_000,
        )

        self.assertEqual(buffering.status, "buffering")
        self.assertFalse(buffering.can_play)
        self.assertEqual(ready.status, "ready")
        self.assertTrue(ready.can_play)
        self.assertTrue(ready.should_persist_unlock)

    def test_content_end_clamps_required_coverage_and_unlock_does_not_regress(self) -> None:
        near_end = evaluate_start_gate(
            started=True,
            fear_mode=True,
            playback_unlocked=False,
            explicit_unprotected=False,
            analysis_ready=True,
            playhead_ms=170_000,
            covered_until_ms=180_000,
            required_buffer_ms=120_000,
            duration_ms=240_000,
            content_end_ms=180_000,
        )
        later_analysis = evaluate_start_gate(
            started=True,
            fear_mode=True,
            playback_unlocked=True,
            explicit_unprotected=False,
            analysis_ready=False,
            playhead_ms=170_000,
            covered_until_ms=180_000,
            required_buffer_ms=120_000,
            duration_ms=240_000,
            content_end_ms=180_000,
        )

        self.assertEqual(near_end.required_until_ms, 180_000)
        self.assertTrue(near_end.should_persist_unlock)
        self.assertTrue(later_analysis.can_play)
        self.assertFalse(later_analysis.should_persist_unlock)


if __name__ == "__main__":
    unittest.main()
