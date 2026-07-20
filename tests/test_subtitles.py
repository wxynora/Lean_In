from __future__ import annotations

import unittest

from together_watch import (
    SubtitleLookupDeadlineExceeded,
    SubtitleLookupPolicy,
    deduplicate_subtitle_candidates,
)


class SubtitleLookupPolicyTest(unittest.TestCase):
    def test_request_timeout_is_bounded_by_the_total_lookup_budget(self) -> None:
        policy = SubtitleLookupPolicy(
            request_timeout_seconds=15,
            lookup_timeout_seconds=45,
            automatic_attempts=1,
        )

        self.assertEqual(policy.timeout_for_request(started_at=100, now=105), 15)
        self.assertEqual(policy.timeout_for_request(started_at=100, now=140), 5)
        with self.assertRaises(SubtitleLookupDeadlineExceeded):
            policy.timeout_for_request(started_at=100, now=145)

    def test_candidates_are_deduplicated_without_a_count_limit(self) -> None:
        candidates = [
            {"url": "https://example.invalid/a", "name": "first"},
            {"url": "https://example.invalid/a", "name": "duplicate"},
            {"url": "", "name": "blank"},
            {"url": "https://example.invalid/b", "name": "second"},
            {"url": "https://example.invalid/c", "name": "third"},
        ]

        result = deduplicate_subtitle_candidates(candidates)

        self.assertEqual([item["name"] for item in result], ["first", "second", "third"])


if __name__ == "__main__":
    unittest.main()
