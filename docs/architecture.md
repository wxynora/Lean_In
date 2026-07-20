# Architecture

TogetherWatch separates deterministic co-watching behavior from player, UI, model, provider, and
storage choices. The portable core defines what each component may see and when its output is still
valid. A host application supplies the actual adapters.

## Design Goals

- Keep the media player's clock authoritative.
- Let visible replies account for normal model latency without exposing later plot.
- Keep local files on the device while permitting narrow, short-lived analysis samples.
- Make every optional capability degrade explicitly.
- Stop provider spending when the client has disappeared or ended the session.
- Keep plot recall inside one active watch session.
- Support browser, desktop, iOS, Android, and embedded-player hosts through the same contracts.

## Non-goals

- Downloading, proxying, or redistributing full media.
- Bypassing DRM, subscriptions, regional restrictions, or source-site controls.
- Defining a companion personality or private prompt.
- Pre-generating dialogue or reactions for an entire work.
- Treating risk predictions or future plot as long-term memory.

## Components

```text
                                      +----------------------+
                                      | Player / media source|
                                      +----------+-----------+
                                                 |
                                      authoritative snapshots
                                                 |
                                                 v
+------------------+      HTTPS/IPC      +--------+---------+       +------------------+
| Browser/native   |<------------------->| Watch host       |<----->| Runtime store    |
| reference client |                     | routes + adapters|       | queue + TTL data |
+--------+---------+                     +---+----------+---+       +------------------+
         |                                   |          |
         | sparse client samples             |          +--------> subtitle/search
         |                                   |
         +-----------------------------------+---------------------> analysis provider
                                             |
                                             +--------------------> chat host/model
```

### Portable Core

The Python package owns:

- media identity and local-file revision rules;
- playback snapshot validation;
- timeline epochs after seek, media replacement, or recovery;
- current, reply-arrival, and scheduled-future windows;
- active-session plot recall;
- risk-event and timed-action validation;
- client sample-plan contracts;
- client-lease and worker-cancellation semantics.

It does not own an HTTP framework, database, video player, UI toolkit, chat model transport, or
provider account. It ships replaceable default analysis and knowledge-card prompts so integrations
share the same evidence and spoiler boundaries without inheriting private product behavior.

### Host Adapters

| Adapter | Responsibility |
| --- | --- |
| `PlaybackAdapter` | Return authoritative snapshots and report seek/media changes. |
| `ClientSampleExporter` | Export only the short frame/audio material authorized by a sample plan. |
| `SourceSampler` | Optionally sample a network-accessible source on the server side. |
| `AnalysisProvider` | Convert frames, audio, subtitles, prior rolling state, and optional background into plot and risk records. |
| `KnowledgeProvider` | Optionally prepare a visible pre-play work-background card. |
| `KnowledgeSearchProvider` | Search through a host-selected external provider and return source rows. |
| `StructuredModelProvider` | Send a provider-neutral prompt bundle through Gemini, OpenAI-compatible, or another host transport. |
| `SubtitleProvider` | Resolve and normalize an optional timed subtitle track. |
| `PlotRecallAdapter` | Retrieve related chunks from the active session and watched range only. |
| `ContextHostAdapter` | Convert a context envelope into the host model's request format. |
| `ActionTransport` | Deliver validated timed actions to the correct client session. |
| `RuntimeStore` | Persist sessions, leases, jobs, plans, chunks, risks, and idempotency records. |

## Media Identity and Time

Every request is tied to four values:

1. `session_id`: one co-watching run;
2. `media_id`: one work/episode/part/local asset;
3. `timeline_epoch`: a generation that changes when prior pending work becomes unsafe;
4. `snapshot_seq`: a monotonically increasing snapshot number inside an epoch.

`snapshot_seq` prevents stale network updates from moving playback backwards. `timeline_epoch`
invalidates already queued analysis, sample plans, risk events, and danmaku after a seek or media
change. Wall-clock time never replaces media time.

For local files, `media_id` is `local:<local_asset_id>`. The random asset ID identifies the user's
selection; `media_revision` detects that the selected file contents changed. Cache keys must include
both values. The original path, blob URL, and file handle stay on the client.

## Session Flow

```text
select media
    |
    v
detect capabilities ---- unsupported/DRM ----> ordinary playback with explicit degradation
    |
    v
create session + lease
    |
    +--> identify work / build optional background card
    +--> locate optional subtitles
    +--> request server or client sample material
    +--> prepare initial risk window when fear mode is enabled
    |
    v
user reviews preparation
    |
    +--> wait for minimum fear coverage
    +--> explicitly continue without protection
    |
    v
unlock playback
    |
    +--> heartbeat
    +--> playback snapshots
    +--> rolling analysis and session-only recall
    +--> chat context and timed actions
    |
    v
DELETE session or lease expiry -> cancel work -> purge temporary material
```

Preparation is user-visible. A host must not call a session synchronized merely because a player
element loaded. It is synchronized only after the gateway has accepted the real media descriptor,
preparation has reached a confirmable state, and the start gate has been resolved.

## Local Media Flow

A local-capable client performs these steps:

1. Select a file and load metadata locally.
2. Verify playback, seek, random future reads, frame export, audio presence/export, and DRM status.
3. Enumerate or select the actual audio and subtitle tracks used by playback.
4. Generate a random `local_asset_id` and a content-sensitive `media_revision`.
5. Create the session without uploading the complete file.
6. Poll status for a client-managed sample plan.
7. Use a second reader to seek to authorized timestamps; never move the visible player.
8. Upload the plan ID, actual sampled range, sparse frames, and optional short audio.
9. Delete local temporary exports after acceptance, rejection, expiry, seek, or session end.

The plan is an authorization boundary. It includes media identity, revision, epoch, purpose, target
timestamps, allowed range, MIME types, and expiry. A host rejects material outside any of those
constraints.

Browser support is intentionally narrower than native/desktop support. The reference browser client
can export sparse frames through a hidden `<video>` element, but reports audio export as unavailable.
That produces an honest frame-only degradation. A native or desktop adapter can export a short
window from the selected audio track.

## Client Liveness

`updated_at` cannot represent client liveness because workers also update rows. Store a separate
client lease:

```text
client_seen_at
client_lease_expires_at
```

Session creation, heartbeat, status polling, playback synchronization, start, subtitle submission,
and sample submission may renew the lease. A dedicated heartbeat remains the reliable idle-playback
path.

Every source, knowledge, subtitle, timeline-prepass, and rolling scheduler checks:

```text
session is not ended AND client lease is valid
```

When the lease expires, the host ends the session as abandoned. It must cancel queued work, request
cancellation of running work, invalidate open sample plans, and purge temporary samples. A worker
restart scans using the lease, not only `ended_at`, so abandoned historical sessions cannot revive.

## Worker State Machine

```text
queued --claim--> running --valid commit--> done
   |                 |
   |                 +--> cancel_requested / stale / expired --> cancelled
   +--> end/expiry -------------------------------------------> cancelled
```

Claiming a job is not permission to spend indefinitely. The worker rechecks session state:

1. immediately after claim;
2. before and after media acquisition;
3. before and after subtitle, search, or model calls;
4. immediately before result commit.

The lease token guards worker ownership. The session lease guards client presence. They are separate.
Canonical skip reasons are `session_ended`, `client_lease_expired`, `cancel_requested`,
`stale_timeline`, and `lease_lost`.

If the provider call already completed when cancellation arrives, the host may have incurred provider
cost, but it must still reject the stale result and avoid recording it as a committed analysis result.
Usage accounting should be written only for provider calls that actually occurred.

## Preparation Modes

The user selects knowledge handling before playback:

- `known`: the companion/host already has enough work context; no broad background card is injected.
- `needs_summary`: a knowledge provider builds a visible background card, which the user confirms or
  explicitly skips.

The choice begins at analysis input construction, not only at final chat injection. A `known` session
must not silently receive the broad card through another field.

Fear mode adds a second gate. Playback stays locked until the initial analyzed protection range is
ready, or the user explicitly chooses to continue without protection. Pending, degraded, and failed
analysis never count as protection.

## Context Boundaries

The host builds separate context regions:

- `story_background`: optional continuity reference selected before playback;
- `related_watched_chunks`: relevant chunks from this session that already ended before the message;
- `current_chunks`: what was happening at the message snapshot;
- `reply_arrival_chunks`: a short lead window that accounts for expected response latency;
- `scheduled_future_chunks`: later material usable only for timed actions.

Visible replies stop at `reply_arrival_until_ms`. Scheduled-future material never enters visible
reply context. The default reply lead is 30 seconds, is adjusted by playback rate, and cannot exceed
two media minutes.

Recall candidates are scoped to the active session, current media, current epoch, cached plot chunks,
and already watched range. They are not long-term memory or global chat-history search.

## Risk and Timed Actions

Risk events contain a warning time, actual start/end, severity, categories, media, and epoch. The
client reacts only to confirmed events for its current session and epoch. A warning may appear early,
but never after the risky interval begins.

Timed danmaku is created from model intent such as `target_ms + text`; the host adds trusted session,
media, epoch, and action identifiers. The client rejects wrong-session, wrong-media, old-epoch,
duplicate, expired, or excessively future actions. Scheduling follows media time, so pause does not
consume the remaining delay.

## Failure and Degradation Matrix

| Failure | Required behavior |
| --- | --- |
| Player works but snapshots are unavailable | Ordinary playback only; synchronization unavailable. |
| Local file plays but random reads fail | No client sampling; rolling analysis and fear protection unavailable. |
| Frames work but audio export does not | Frame/subtitle analysis only, explicitly marked degraded. |
| Subtitle provider is absent or no match exists | Continue with available audio/frames; show subtitle status. |
| Knowledge provider fails in summary mode | Show failure and allow explicit skip/retry according to host policy. |
| Initial fear coverage is pending | Keep playback locked or require explicit unprotected continuation. |
| Client disappears | Lease expiry ends the session and stops new work. |
| Seek occurs during a provider call | Reject the old result at the post-call/commit guard. |
| DELETE races with a running job | Mark cancellation requested; post-call guard prevents commit. |

## Deployment Checklist

- Persist independent client leases and worker lease tokens.
- Make session end and queued/open-plan cancellation one transaction.
- Recheck liveness at every scheduler and expensive worker boundary.
- Keep cache keys revision- and epoch-aware.
- Use short-lived object storage or local temporary storage for samples.
- Separate provider credentials from browser configuration.
- Configure CORS and user authentication when the Web client is cross-origin.
- Expose explicit pending/degraded/failed states to clients.
- Log skip reasons without logging subtitle bodies, image bytes, chat text, or provider secrets.
- Test process death, network loss, seek races, end races, and worker restart behavior.
