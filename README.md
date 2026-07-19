# TogetherWatch

TogetherWatch is a platform-neutral co-watching runtime for AI companions. It keeps a chat model,
media player, rolling plot analysis, timed danmaku, and optional high-intensity-scene protection on
the same media clock without requiring Android, a specific player, or a specific model provider.

The repository contains:

- a dependency-free Python core for timeline, context, recall, actions, local-media contracts, and
  client-liveness semantics;
- a versioned JSON protocol and integration documentation;
- a functional browser reference client that can connect to a compatible gateway;
- host adapter interfaces for playback, chat, sampling, analysis, knowledge search, subtitles,
  storage, and action delivery;
- deterministic Python and JavaScript regression tests.

> **Project status:** alpha. The contracts are usable, but route compatibility may still evolve.
>
> **License:** source-available under the PolyForm Noncommercial License 1.0.0. Commercial use is
> not permitted. See [License](#license).

## Why This Exists

Ordinary chat knows when a message arrived, but it does not know what was on screen at that exact
moment. Video also keeps moving while a model prepares its response. TogetherWatch solves that by
separating four timeline regions:

1. already watched plot that may be recalled for the current conversation;
2. the scene visible when the user sent the message;
3. a limited reply-arrival window that is expected to play before the response reaches the user;
4. later future plot that may schedule timed actions but must never leak into visible replies.

The player clock remains authoritative. The model does not estimate the position from wall-clock
time, message time, or a pre-generated reaction script.

## Implemented Behavior

- Monotonic playback snapshots with `timeline_epoch` and `snapshot_seq`.
- Seek and media-change invalidation for stale analysis, actions, and client sample plans.
- A configurable reply-arrival window from 0 to 120 media seconds.
- Session-only related-plot recall; no long-term chat or memory search.
- Known-work and needs-background preparation modes selected explicitly before playback.
- Optional work-background cards, subtitles, sparse visual context, and rolling story state.
- Timed danmaku validation against session, media, epoch, media time, and duplicate action IDs.
- Confirmed risk windows for warning or client-side screen covering.
- Local video playback without uploading the complete media file.
- Random local asset IDs plus content-sensitive `media_revision` values to prevent cache reuse after
  a file is replaced.
- Client-managed sparse frame/audio plans with an allowed media range and expiry time.
- Independent client leases, atomic session ending, queued-job cancellation, running-job
  cancellation requests, and worker guard checkpoints.
- A browser reference client with real session creation, heartbeat, status polling, playback
  snapshots, preparation gates, local subtitles, sparse frame extraction, risk UI, and host chat
  integration.

## Architecture

```text
                               +-------------------------+
Player / local media ----------> PlaybackAdapter         |
                               |                         |
Sparse frames / short audio ---> SamplingAdapter         |
                               |                         |
Chat host ---------------------> ContextHostAdapter      |
                               |   TogetherWatch core    |----> model request
Model action -------------------> Action validator        |
                               |                         |
Risk + danmaku <---------------- ActionTransport         |
                               +------------+------------+
                                            |
                                            v
                               Persistent runtime store
                               + analysis worker queue
```

The portable Python package is not an HTTP server. A production host supplies persistence and
provider adapters. The included Web client targets the reference gateway contract documented
below, but the route prefix and authentication headers are configurable.

Read [Architecture](docs/architecture.md), [Protocol](docs/protocol.md), and
[Privacy](docs/privacy.md) for the deeper contracts.

## Quick Start

The Python package has no runtime dependencies.

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python examples/mock_client.py
```

Without installing the package:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src python3 examples/mock_client.py
```

Run the Web reference client:

```bash
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080/web/`. Edit `web/config.js` first when the gateway is not served from
the same origin. Full Web setup is documented in [web/README.md](web/README.md).

## Python Core Example

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

## Client Liveness and Worker Safety

`updated_at` is not a client-liveness signal because workers also update it. A persistent host must
store an independent client lease, such as:

```json
{
  "client_seen_at": "2026-01-01T00:00:00Z",
  "expires_at": "2026-01-01T00:01:30Z",
  "valid": true
}
```

The reference duration is 90 seconds and the Web client sends a heartbeat every 30 seconds. A host
may choose other values, but heartbeat cadence must remain shorter than the lease.

Every source, knowledge, subtitle, prepass, and rolling scheduler must require both conditions:

- the session is not ended;
- the independent client lease is still valid.

Ending a session is one atomic transition:

- mark the session ended;
- cancel queued/deferred work;
- mark running work `cancel_requested`;
- invalidate open client sample plans;
- remove temporary samples and derived visual frames.

A worker must guard a claimed task at these boundaries:

1. immediately after claim;
2. before and after media acquisition;
3. before and after subtitle/search/model provider calls;
4. before result commit.

The canonical skip reasons are `session_ended`, `client_lease_expired`, `cancel_requested`,
`stale_timeline`, and `lease_lost`. Model usage is recorded only after a real provider call and only
if the result is still allowed to commit. `WorkCoordinator` in `src/together_watch/lifecycle.py`
provides a tested storage-neutral reference for these transitions.

## Reference Gateway Contract

The Web client uses this route family by default:

```text
/miniapp-api/watch
```

Change it with `watchApiBasePath` in `web/config.js`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | List active/recent sessions for a window. |
| `POST` | `/sessions` | Create a session after media capability detection. |
| `GET` | `/sessions/{id}/status` | Read preparation, playback, analysis, sample plan, risks, and start gate. |
| `POST` | `/sessions/{id}/heartbeat` | Renew the independent client lease. |
| `PUT` | `/sessions/{id}/playback` | Apply an authoritative player snapshot. |
| `POST` | `/sessions/{id}/start` | Confirm/skip preparation and apply the initial protection gate. |
| `PUT` | `/sessions/{id}/mode` | Update supported runtime mode fields. |
| `POST` | `/sessions/{id}/knowledge-card/regenerate` | Rebuild a pre-play background card. |
| `POST` | `/sessions/{id}/subtitles/retry` | Retry a configured network subtitle provider. |
| `POST` | `/sessions/{id}/local-subtitles` | Submit selected local SRT/VTT text and alignment metadata. |
| `POST` | `/sessions/{id}/analysis/samples` | Submit only material authorized by a client sample plan. |
| `DELETE` | `/sessions/{id}` | End the session and cancel/purge its remaining work. |
| `GET` | `/bilibili/parts` | Resolve title, real duration, and all parts for a BV ID. |

### Create a Local Session

The original file path is never sent. `local_asset_id` is random for the selected asset;
`media_revision` identifies the selected file contents within that asset.

```json
{
  "window_id": "together-watch:web",
  "companion": { "id": "companion", "name": "Companion" },
  "media": {
    "id": "local:71da7cb4-95d1-4ee0-a4ac-dc2d77e9af65",
    "source": "local_file",
    "title": "Example Movie",
    "duration_ms": 7200000,
    "content_start_ms": 0,
    "content_end_ms": 7080000,
    "local_media": {
      "local_asset_id": "71da7cb4-95d1-4ee0-a4ac-dc2d77e9af65",
      "media_revision": "sha256-or-host-revision",
      "capabilities": {
        "can_play": true,
        "can_seek": true,
        "can_read_future": true,
        "can_export_frames": true,
        "can_export_audio": false,
        "has_audio": true,
        "is_drm": false
      },
      "selected_audio": {
        "track_id": "browser-default",
        "language": "",
        "label": "Browser default track"
      },
      "selected_subtitle": {
        "kind": "external",
        "track_id": "external-file",
        "language": "zh-CN",
        "label": "example.srt",
        "format": "srt",
        "offset_ms": 0
      }
    }
  },
  "mode": {
    "knowledge_mode": "known",
    "fear_mode": false,
    "fear_action": "warn_only",
    "danmaku_enabled": true,
    "reply_lead_ms": 30000,
    "visual_context_mode": "text_plus_contact_sheet"
  }
}
```

Capability detection is explicit. A client that can play but cannot read future positions or export
frames may continue ordinary playback, while rolling plot analysis and fear protection remain
visibly unavailable. DRM-protected media must never be reported as sampleable.

### Client Sample Plan

A client-managed plan is a short-lived authorization, not a suggestion:

```json
{
  "plan_id": "watch_plan_...",
  "managed_by": "client",
  "media_id": "local:71da7cb4-95d1-4ee0-a4ac-dc2d77e9af65",
  "media_revision": "sha256-or-host-revision",
  "timeline_epoch": 2,
  "purpose": "rolling",
  "target_timestamps_ms": [930000, 945000, 960000],
  "allowed_start_ms": 930000,
  "allowed_end_ms": 960000,
  "audio_required": false,
  "expires_at": "2026-01-01T00:15:00Z"
}
```

The client must verify the plan ID, media ID, revision, epoch, allowed range, and expiry. It reports
the actual exported range on upload. Seek or file replacement invalidates the old plan. A second
reader should extract samples so the visible player is never moved.

The browser client exports sparse JPEG frames with a hidden `<video>` element. It currently reports
`can_export_audio=false`; a native or desktop host may provide the selected short audio window. The
gateway must degrade honestly when audio is unavailable instead of pretending it received audio.

## Preparation and Start Gate

Playback remains paused while preparation is visible. Typical states are:

```text
identifying -> collecting_sources -> building_card -> searching_subtitles -> ready_to_confirm
```

The user explicitly chooses whether the companion already knows the work:

- `known`: do not inject or display a broad story-background card;
- `needs_summary`: prepare a visible card, let the user inspect it, and require confirmation or an
  explicit skip before playback.

If fear mode is enabled, confirmation does not automatically imply that playback is protected. The
start gate may return:

- `buffering`: wait for an initial analyzed risk window;
- `ready_to_unlock`: call start again to unlock after coverage becomes sufficient;
- `unprotected`: the user explicitly chose to continue without protection;
- `ready`: playback may begin.

A client must never label `pending`, `degraded`, or `failed` analysis as protected.

## Analysis, Knowledge, and Subtitle Providers

TogetherWatch does not require one model vendor. A host can connect any provider that implements
the adapter contracts.

Recommended analysis input for a rolling batch:

- sparse frames from the authorized time window;
- a short audio window when the client/source can export it;
- matching subtitles when available;
- the previous rolling story state;
- a work-background card only when the selected mode requires one.

The analysis result should contain objective plot chunks, dialogue attribution, visual details,
rolling story state, timeline sections, and deterministic risk windows. Subtitles assist
understanding; actual image and audio evidence wins when subtitles are misaligned or belong to a
different edit.

Work-background search is optional. A deployment may use a search-capable model, a dedicated search
API followed by a model, or let its multimodal model build a lightweight card if that provider has
reliable retrieval. The card should identify the work, setting, pre-story, major characters,
relationships, terminology, and a coarse outline. It is continuity reference, not permission to
spoiler future scenes.

Subtitle lookup is also optional. Supported adapter choices include:

- a user-selected local `.srt` or `.vtt` file;
- [SubDL API](https://subdl.com/api-doc);
- [OpenSubtitles.com REST API](https://ai.opensubtitles.com/docs);
- a self-hosted [ChineseSubFinder](https://github.com/ChineseSubFinder/ChineseSubFinder) workflow;
- another provider normalized to the same timed-cue contract.

No provider should be configured as an implicit requirement. Use an explicit `not_configured` or
`not_found` state and continue with audio plus frames when possible.

## Session-Only Recall

The included BM25 recall implementation is deliberately limited:

- candidates come only from plot chunks cached for the active watch session;
- candidates must have ended before the message playhead;
- old timeline epochs are excluded;
- a character-name-only query is downweighted to avoid returning many noisy chunks;
- the cache TTL belongs to the host; 24 hours is a practical default.

This is not a global memory search and it does not query chat history. Downstream projects may
replace or remove the recall implementation while adapting the code; there is no product-facing
runtime switch in the reference UI.

## Chat and Timed Actions

The Web client deliberately does not invent assistant messages. A host provides
`TogetherWatchHost.sendMessage`, and every message request contains:

```json
{
  "text": "What did that clue mean?",
  "watch_session_id": "watch_...",
  "watch_snapshot": {
    "media_id": "local:...",
    "playhead_ms": 930000,
    "is_playing": true,
    "playback_rate": 1.0,
    "timeline_epoch": 2,
    "snapshot_seq": 17,
    "captured_at": "2026-01-01T00:20:00Z"
  }
}
```

Model-facing hosts should expose a native danmaku tool with `target_ms` and `text`. The host adds
session/media/epoch/action identifiers, validates the result, and delivers it to the client. The Web
transport contract is in [web/README.md](web/README.md).

## Privacy and Retention

- Do not upload complete local media files.
- Keep sample plans narrow and short-lived.
- Delete source audio/frame samples after the analysis result is committed or cancelled.
- Delete derived visual frames when the session ends, the epoch changes, or their TTL expires.
- Keep rolling plot chunks session-scoped and expire them according to the deployment policy.
- Do not place future-only chunks in visible model context.
- Do not include private companion names, prompts, credentials, or chat archives in provider
  prompts unless the host explicitly owns that behavior.

See [docs/privacy.md](docs/privacy.md) for the complete boundary.

## Repository Layout

```text
src/together_watch/   Portable models, lifecycle, timeline, recall, context, and action logic
schema/               JSON Schema for public wire contracts
tests/                Python contract and regression tests
examples/             Small host/client examples
web/                  Functional configurable browser reference client and JavaScript tests
docs/                 Architecture, protocol, privacy, and integration details
```

## Verification

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
python3 -m compileall -q src examples tests
(cd web && npm test)
```

The tests do not call network providers or require mobile SDKs.

## Non-goals

- Downloading, proxying, or redistributing complete movies.
- Bypassing subscriptions, DRM, regional restrictions, or source-site access controls.
- Pre-generating companion dialogue or reactions.
- Treating future plot as visible reply context.
- Storing local samples as long-term memory.
- Defining a companion personality or private relationship prompt.
- Shipping a production gateway, database, or model provider in this repository.

## License

TogetherWatch is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal,
research, educational, and other uses permitted by that license are allowed. Commercial use is not
permitted.
