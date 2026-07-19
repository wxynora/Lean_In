# TogetherWatch

TogetherWatch is a platform-neutral co-watching core for AI companions. It keeps a chat
model aligned with the media position a person is actually watching, without coupling the
timeline, context, or action protocol to Android, a specific player, or a specific model vendor.

> Status: alpha. The first extraction contains the portable protocol, deterministic core,
> adapter interfaces, a mock client, and tests. Production media acquisition and multimodal
> analysis providers are intentionally separate adapters.
>
> Licensing: this is source-available software, not an OSI-approved open-source release.
> Commercial use is not permitted by the included license.

## What It Does

- Treats the player's media clock as the only playback source of truth.
- Rejects stale snapshots after seek, recovery, or media changes with `timeline_epoch` and
  monotonic `snapshot_seq` checks.
- Splits context into watched, current, reply-arrival, and later scheduled windows.
- Recalls related plot only from cached chunks in the active watch session.
- Validates timed danmaku actions against the active media, epoch, and spoiler window.
- Models upcoming risk events for warning or local screen-covering clients.
- Supports server-managed media sampling and optional client-managed sampling for local files.
- Keeps the core independent from Android SDK, WebView, Media3, chat archives, and private
  companion prompts.

## Architecture

```text
Host client -> PlaybackAdapter -> playback snapshots -> TogetherWatch core
                                                   -> analysis/sample plans
Chat host  <- ContextHostAdapter <- context envelope <- cached plot and risk events
Host client <- ActionTransport <- validated timed actions
```

The same core can run as a standalone service or inside an existing chat backend. A host supplies
adapters for playback, media sampling, multimodal analysis, subtitles, knowledge search, storage,
chat-context injection, and action delivery.

See [Architecture](docs/architecture.md), [Protocol](docs/protocol.md), and
[Privacy](docs/privacy.md).

## User Interface

The repository includes a navigable [Web UI reference](web/) alongside the portable core. It
mirrors the two-stage product flow: playback confirmation first, then preparation, playback,
conversation, timed danmaku, and optional high-intensity-scene protection in one watch screen.

The Web files are a visual and structural reference, not a production client. They intentionally
exclude the private Android product code and do not call a real chat or analysis backend. Client
authors can port the same flow to Android, iOS, desktop, or another Web stack without changing the
portable timeline and context contracts.

## Optional Integrations

Subtitle lookup is an optional accuracy enhancement, not a requirement for TogetherWatch.
Playback and audio/frame analysis can continue without any subtitle provider. A host that wants
subtitle assistance can adapt one or more of these sources:

- A local `.srt`, `.ass`, or `.vtt` file, with no network service or API key.
- [SubDL API](https://subdl.com/api-doc).
- [OpenSubtitles.com REST API](https://ai.opensubtitles.com/docs).
- A self-hosted [ChineseSubFinder](https://github.com/ChineseSubFinder/ChineseSubFinder) instance
  or an import adapter for files it has already downloaded.

The repository does not require any one provider. When none is configured, the host should expose
an explicit `not_configured` preparation state instead of treating subtitles as a failure.

Related-plot recall is optional too. The included session-only BM25 implementation is a portable
default that downstream projects may keep, replace, or remove while adapting the project. It only
ranks plot chunks supplied from the active watch session; it does not search a host application's
long-term memory or chat archive, and it does not require an embedding service.

## Quick Start

The package has no runtime dependencies.

```bash
python -m unittest discover -s tests -v
python examples/mock_client.py
```

Minimal usage:

```python
from together_watch import (
    ClientCapabilities,
    KnowledgeMode,
    MediaDescriptor,
    PlaybackSnapshot,
    SessionMode,
    WatchCore,
)

core = WatchCore()
session = core.create_session(
    media=MediaDescriptor(
        media_id="demo:episode-1",
        source="html5",
        title="Demo Episode",
        duration_ms=1_800_000,
    ),
    mode=SessionMode(knowledge_mode=KnowledgeMode.NEEDS_SUMMARY),
    capabilities=ClientCapabilities(playback_snapshot=True),
)
core.start_session(session.session_id)
core.apply_snapshot(
    session.session_id,
    PlaybackSnapshot(
        media_id="demo:episode-1",
        playhead_ms=90_000,
        duration_ms=1_800_000,
        is_playing=True,
        playback_rate=1.0,
        timeline_epoch=0,
        snapshot_seq=1,
        captured_at="2026-01-01T00:00:00Z",
    ),
)
```

## Repository Layout

```text
src/together_watch/   Portable models, timeline logic, recall, actions, and adapter protocols
tests/                Contract and regression tests with no mobile SDK or network access
examples/             Small host/client examples
web/                  Navigable cross-platform UI reference; no private product source
docs/                 Architecture, wire protocol, privacy, and integration boundaries
```

## Non-goals

- Downloading, proxying, or redistributing full movies.
- Bypassing subscriptions, DRM, regional restrictions, or source-site access controls.
- Pre-generating a companion's dialogue or reactions.
- Storing future plot, frames, or uploaded local-media samples as long-term memory.
- Defining a companion personality or private relationship prompt.

## License

TogetherWatch is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal,
research, educational, and other permitted noncommercial uses are allowed under its terms;
commercial use is not permitted.
