# Lean In

Lean In is a platform-neutral co-watching runtime for AI companions. It keeps a chat model,
media player, rolling plot analysis, timed danmaku, and optional high-intensity-scene protection on
the same media clock without requiring Android, a specific player, or a specific model provider.

The Python import path (`together_watch`) and Web host globals (`TogetherWatchHost` and
`TogetherWatchConfig`) retain their original names for integration compatibility.

The repository contains:

- a dependency-free Python core for timeline, context, recall, actions, local-media contracts, and
  client-liveness semantics;
- a versioned JSON protocol and integration documentation;
- a functional browser reference client that can connect to a compatible gateway;
- host adapter interfaces for playback, chat, sampling, analysis, knowledge search, subtitles,
  storage, and action delivery;
- reusable Gemini-oriented analysis and knowledge-card prompts with strict JSON schemas;
- explicit model and knowledge-search configuration contracts with no private provider dependency;
- deterministic Python and JavaScript regression tests.

> **Project status:** alpha. The contracts are usable, but route compatibility may still evolve.
>
> **License:** source-available under the PolyForm Noncommercial License 1.0.0. Commercial use is
> not permitted. See [License](#license).

## Why This Exists

Ordinary chat knows when a message arrived, but it does not know what was on screen at that exact
moment. Video also keeps moving while a model prepares its response. Lean In solves that by
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
- Optional work-background cards, subtitles, sparse visual context, and session-scoped plot chunks.
- Timed danmaku from native tool calls or hidden short markers, with shared validation against
  session, media, epoch, media time, and duplicate action IDs.
- Confirmed risk windows for warning or client-side screen covering.
- Local video playback without uploading the complete media file.
- Random local asset IDs plus content-sensitive `media_revision` values to prevent cache reuse after
  a file is replaced.
- Client-managed sparse frame/audio plans with an allowed media range and expiry time.
- Independent client leases, atomic session ending, queued-job cancellation, running-job
  cancellation requests, and worker guard checkpoints.
- Server-observed viewing duration, cross-part `viewing_id` aggregation, real completion gates,
  stable structured tickets, and a persistent ticket-shelf contract.
- Distinct technical cleanup, resumable save-progress, and completed-viewing transitions.
- Saved playback plus retained plot analysis for Recent Watch, and a configurable 24-hour default
  TTL for plot analysis only after a viewing is marked complete.
- Viewing-level persistence for multiple user-confirmed JPEG captures, plus one independently
  selected ticket back that can be changed after completion.
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
                               |      Lean In core       |----> model request
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

Read [Architecture](docs/architecture.md), [Protocol](docs/protocol.md),
[Provider and Prompt Integration](docs/providers.md), and [Privacy](docs/privacy.md) for the deeper
contracts.

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
`stale_timeline`, and `lease_lost`. Billing usage is recorded only after a real provider response;
an invalid structured result may still have billable usage even though no plot data is committed.
Persist that usage before the post-call liveness check so an end/seek race cannot erase a call that
already happened. Keep task completion and pricing completeness separate: a provider may finish a
call without returning a USD price.
Do not stop an otherwise active session because it reaches a fixed lifetime count of analysis jobs;
long media naturally requires more rolling batches. Do not silently defer work at a daily-cost
threshold either; report real provider usage to the host and viewer. Bound execution through session
leases, cancellation, and authorized media ranges.
`WorkCoordinator` in `src/together_watch/lifecycle.py` provides a tested storage-neutral reference
for lifecycle transitions.

## Reference Gateway Contract

The Web client uses this route family by default:

```text
/miniapp-api/watch
```

Change it with `watchApiBasePath` in `web/config.js`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | List active/recent sessions for a window. |
| `POST` | `/sessions` | Idempotently create a session after media capability detection. |
| `GET` | `/sessions/{id}/status` | Read preparation, playback, analysis, sample plan, risks, and start gate. |
| `GET` | `/viewings?status=resumable` | List saved viewing progress for Recent Watch. |
| `GET` | `/viewings/{id}` | Restore one cross-part viewing summary and its stable ticket. |
| `GET` / `POST` | `/viewings/{id}/ticket-frame-captures` | List or save user-confirmed ticket screenshots. |
| `GET` | `/viewings/{id}/ticket-frame-captures/{capture_id}/image` | Read one authenticated persistent screenshot. |
| `PUT` / `DELETE` | `/viewings/{id}/ticket-frame` | Select or clear one retained analysis frame for the ticket back. |
| `GET` | `/tickets` | List completed structured tickets for the ticket shelf. |
| `PUT` | `/tickets/{id}` | Save an edited ticket title. |
| `POST` | `/sessions/{id}/heartbeat` | Renew the independent client lease. |
| `PUT` | `/sessions/{id}/playback` | Apply an authoritative player snapshot. |
| `POST` | `/sessions/{id}/start` | Confirm/skip preparation and enter the initial plot-coverage gate. |
| `PUT` | `/sessions/{id}/mode` | Update supported runtime mode fields. |
| `POST` | `/sessions/{id}/knowledge-card/regenerate` | Rebuild a pre-play background card. |
| `POST` | `/sessions/{id}/subtitles/retry` | Retry a configured network subtitle provider. |
| `POST` | `/sessions/{id}/local-subtitles` | Submit selected local SRT/VTT text and alignment metadata. |
| `POST` | `/sessions/{id}/analysis/samples` | Submit only material authorized by a client sample plan. |
| `DELETE` | `/sessions/{id}` | Cleanup, save progress, or complete the viewing according to `viewing_action`. |
| `GET` | `/bilibili/parts` | Resolve title, real duration, and all parts for a BV ID. |

### Create a Local Session

The original file path is never sent. `local_asset_id` is random for the selected asset;
`media_revision` identifies the selected file contents within that asset.

```json
{
  "window_id": "together-watch:web",
  "companion": { "id": "companion", "name": "{assistant}" },
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

Confirmation starts preparation but does not immediately unlock playback. Every mode waits for an
initial analyzed plot buffer; hosts should use a five-minute (`300000` ms) default and clamp the
requirement to the actual content end. The start gate may return:

- `buffering`: wait for the initial analyzed plot range;
- `unprotected`: in fear mode only, the user explicitly chose to continue without protection;
- `ready`: playback may begin.

When an analysis result first reaches the required initial coverage, the host persists the playback
unlock in the same transaction as that result. The client learns `can_play=true` from status polling;
it does not need to call start a second time. A later rolling job cannot relock an unlocked session.

Fear mode uses the same initial plot gate and additionally requires real risk coverage. Only fear
mode may expose the explicit unprotected continuation action; ordinary mode has no bypass.

A client must never label `pending`, `degraded`, or `failed` analysis as protected.

Completed analysis is a media-time cache, not disposable epoch output. A seek still invalidates
queued jobs, open sample plans, pending actions, and stale delivery state, but a host should reuse
completed plot/risk coverage when the media identity and local revision are unchanged. Approximate
viewer corrections to intro/outro ranges are sampling references only: they may redirect unfinished
sampling, but must not advance coverage by themselves or delete completed provider results.

## Analysis, Knowledge, and Subtitle Providers

Lean In does not require one model vendor. A host can connect any provider that implements
the adapter contracts. The package includes default Gemini-oriented prompts, strict analysis and
knowledge-card schemas, prompt builders, and explicit provider configuration types. See
[Provider and Prompt Integration](docs/providers.md).

Recommended analysis input for a rolling batch:

- sparse frames from the authorized time window;
- a short audio window when the client/source can export it;
- matching subtitles when available;
- plot chunks from the immediately preceding analysis window;
- a work-background card only when the selected mode requires one.

The start gate should require five minutes of reliable plot coverage. After unlock, the backend may
continue full rolling batches until it reaches the earlier of 30 minutes ahead or the detected normal
content end. Once that high-water mark is reached, wait until one full batch has been consumed before
refilling. Do not turn each small playhead change into a short provider call. A short final batch is
valid only when it ends at the normal content boundary, not at uploader-added padding after credits.
`plan_rolling_prefetch()` provides this storage-neutral decision.

The analysis result should contain objective plot chunks, dialogue attribution, visual details,
an optional current story background, timeline sections, and deterministic risk windows. Subtitles
assist understanding; actual image and audio evidence wins when subtitles are misaligned or belong
to a different edit. Rolling calls do not maintain a cumulative plot summary or event state.

Requesting schema-constrained output is recommended, but the receiver must not assume every provider
returns one bare JSON string. `parse_openai_compatible_response()` accepts structured message fields,
content blocks, code fences, surrounding prose, and deterministic trailing-comma errors while still
rejecting truncated JSON and results without required analysis fields.

Work-background search is optional. A deployment may use a search-capable model, a dedicated search
API followed by a model, or let its multimodal model build a lightweight card if that provider has
reliable retrieval. The card should identify the work, setting, pre-story, major characters,
relationships, terminology, and a coarse outline. It is continuity reference, not permission to
spoiler future scenes.

`KnowledgeSearchConfig` makes that choice explicit: `external`, `model_native`, or `disabled`.
The query template, title preference, endpoint, API-key environment variable, and provider options
belong to the integrating host. The included example uses the original title when available and the
query `《{title}》剧情简介 主要人物 人物关系 世界观`.

Subtitle lookup is also optional. Supported adapter choices include:

- a user-selected local `.srt` or `.vtt` file;
- [SubDL API](https://subdl.com/api-doc);
- [OpenSubtitles.com REST API](https://ai.opensubtitles.com/docs);
- a self-hosted [ChineseSubFinder](https://github.com/ChineseSubFinder/ChineseSubFinder) workflow;
- another provider normalized to the same timed-cue contract.

No provider should be configured as an implicit requirement. Use an explicit `not_configured` or
`not_found` state and continue with audio plus frames when possible.

TMDB identity resolution is an optional manual-retry enhancement, not another subtitle provider.
Leave `tmdb_identity.enabled=false` to use ordinary title/original-title lookup only. When enabled,
the host reads `TOGETHER_WATCH_TMDB_READ_ACCESS_TOKEN` on the server and may resolve one TMDB movie
or TV ID after the first subtitle lookup has already failed and the viewer explicitly retries. The
token must never be exposed through `web/config.js` or sent to the browser. TMDB absence or failure
must not block SubDL title lookup, local subtitles, or playback.

For network providers, keep subtitle waits independent from long media-extraction timeouts. The
included `SubtitleLookupPolicy` defaults to 15 seconds per request, 45 seconds for one lookup, and
one automatic attempt; the UI can expose an explicit retry after failure. Candidate download URLs
can be deduplicated without silently limiting how many unique candidates the host may try.

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

The host can turn the returned context envelope into the companion's dynamic system message with the
included private-name-free template:

```python
from together_watch import build_companion_context_prompt

system_text = build_companion_context_prompt(
    envelope=context_envelope,
    assistant_name="{assistant}",
    viewer_name="{viewer}",
    work_name="{work}",
    analysis_ready=True,
    danmaku_enabled=True,
)
```

This prompt does not define the companion personality or generate a reply in advance. It only tells
the real chat model what has happened at the message position, which watched chunks are relevant,
what may happen before the reply arrives, and which later chunks are restricted to timed actions.
For optional contact sheets, insert a separate user image block labeled `【剧情画面】` immediately
before the real viewer message.

Model-facing hosts may use either of two adapters:

- a native danmaku tool with `target_ms` and `text`;
- the hidden short marker `[watch:danmaku HH:MM:SS content]` when tool calls are unavailable or less
  reliable in the selected chat runtime.

For the marker path, add this instruction to the host's model context:

```text
If you want to send a timed danmaku, append one hidden marker to the end of the reply:
[watch:danmaku media_time content]
Use MM:SS or HH:MM:SS media time from the supplied scheduled-future window. Omit the marker when no
danmaku is needed.
```

Use `split_danmaku_markers()` on the completed response and
`visible_danmaku_stream_text()` while streaming so the marker never reaches visible chat. Every
parsed intent must still go through `WatchCore.prepare_danmaku()`; the host adds trusted
session/media/epoch/action identifiers, applies the same time-window and duplicate validation used
for tool calls, and only then delivers the event. Marker names are configurable, but the portable
default is `watch:danmaku` and contains no product or companion identity. Do not archive the hidden
marker as assistant-visible text. The Web transport contract is in [web/README.md](web/README.md).

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

Lean In is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal,
research, educational, and other uses permitted by that license are allowed. Commercial use is not
permitted.
