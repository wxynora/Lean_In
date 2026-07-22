import unittest

from together_watch.adapters import (
    SourceCandidateFailure,
    sample_frames_with_refresh,
)


class SourceSamplingAdapterTests(unittest.TestCase):
    def test_promotes_backup_and_refreshes_only_the_failed_frame(self) -> None:
        resolutions = iter(
            [
                ["expired-primary", "working-backup"],
                ["fresh-primary", "fresh-backup"],
            ]
        )
        resolve_calls = 0
        attempts: list[tuple[str, int]] = []

        def resolve() -> list[str]:
            nonlocal resolve_calls
            resolve_calls += 1
            return next(resolutions)

        def extract(url: str, at_ms: int) -> bytes:
            attempts.append((url, at_ms))
            if url == "expired-primary":
                raise SourceCandidateFailure("403")
            if at_ms == 2_000 and url == "working-backup":
                raise SourceCandidateFailure("signed URL expired")
            return f"{url}:{at_ms}".encode()

        samples = sample_frames_with_refresh(
            [1_000, 2_000, 3_000],
            resolve_stream_urls=resolve,
            extract_frame=extract,
        )

        self.assertEqual(resolve_calls, 2)
        self.assertEqual(
            attempts,
            [
                ("expired-primary", 1_000),
                ("working-backup", 1_000),
                ("working-backup", 2_000),
                ("expired-primary", 2_000),
                ("fresh-primary", 2_000),
                ("fresh-primary", 3_000),
            ],
        )
        self.assertEqual(
            samples,
            (
                (1_000, b"working-backup:1000"),
                (2_000, b"fresh-primary:2000"),
                (3_000, b"fresh-primary:3000"),
            ),
        )


if __name__ == "__main__":
    unittest.main()
