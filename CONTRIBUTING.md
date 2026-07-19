# Contributing

TogetherWatch is in its initial extraction phase. Keep changes inside the portable domain unless
an adapter explicitly owns platform or provider details.

## Development

```bash
python -m unittest discover -s tests -v
python -m compileall -q src tests examples
```

Contributions should include a regression test for timeline, spoiler-window, action-validation,
or storage-boundary changes. Tests must not contact production services, use real credentials,
or include copyrighted media fixtures.

By contributing, you agree that your contribution is distributed under the repository's
[PolyForm Noncommercial License 1.0.0](LICENSE).

## Boundaries

- Do not add companion names, private prompts, chat logs, cookies, tokens, or absolute local paths.
- Do not import mobile SDKs or chat-product internals into `src/together_watch`.
- Keep provider-specific request formats in adapters.
- Preserve playback as the source of truth; wall-clock estimates cannot replace media snapshots.
