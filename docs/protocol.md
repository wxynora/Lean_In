# Protocol v1

TogetherWatch uses media time in integer milliseconds. JSON field names are stable public-contract
names; storage layout, HTTP framework, model tool syntax, and event transport remain host choices.

The reference Web client uses `/miniapp-api/watch`, configurable through `web/config.js`. Examples
below omit product authentication headers.

## Conventions

- Times ending in `_ms` are media-time milliseconds unless explicitly named as wall-clock time.
- ISO timestamps such as `captured_at` and `expires_at` should include a timezone.
- IDs are opaque strings. Clients must not infer database structure from them.
- A successful HTTP envelope may include `{"ok": true, ...}`.
- A failed envelope should include `{"ok": false, "error": "...", "code": "..."}`.
- Clients must preserve unknown response fields so hosts can add optional data compatibly.
- The JSON Schema in `schema/watch-v1.schema.json` defines reusable wire objects; route envelopes are
  documented here because hosts may expose them through HTTP, IPC, or another transport.

## Media Descriptor

Network/embedded example:

```json
{
  "id": "bilibili:BV...:p1",
  "source": "bilibili_embed",
  "source_url": "https://www.bilibili.com/video/BV...?p=1",
  "embed_url": "https://player.bilibili.com/player.html?...",
  "title": "Example Work",
  "part_title": "Episode 1",
  "part_index": 1,
  "duration_ms": 1452000,
  "content_start_ms": 60000,
  "content_end_ms": 1390000
}
```

Local example:

```json
{
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
      "language": "ja",
      "label": "movie.ja.srt",
      "format": "srt",
      "offset_ms": 1500
    }
  }
}
```

`content_start_ms` is where actual program content begins. `content_end_ms` is where credits or
non-program material begins. Both are optional and must fit inside `duration_ms`. Analysis and risk
coverage should stay inside that range.

For local media:

- `id` must equal `local:<local_asset_id>`;
- `local_asset_id` is random and contains no local path;
- `media_revision` changes when the selected file contents change;
- `selected_audio` identifies the track actually used for analysis/playback;
- `selected_subtitle` is `none`, `embedded`, or `external` and carries signed alignment offset;
- `is_drm=true` means client sampling is unavailable even if the player can render the file.

## Mode

```json
{
  "knowledge_mode": "needs_summary",
  "fear_mode": true,
  "fear_action": "cover_video",
  "danmaku_enabled": true,
  "reply_lead_ms": 30000,
  "visual_context_mode": "text_plus_contact_sheet"
}
```

| Field | Values and behavior |
| --- | --- |
| `knowledge_mode` | `known` or `needs_summary`; selected before playback. |
| `fear_mode` | Boolean in the reference HTTP contract; portable core also models off/warn/cover explicitly. |
| `fear_action` | `warn_only` or `cover_video`. |
| `danmaku_enabled` | Whether timed companion actions may be shown. |
| `reply_lead_ms` | Expected response-latency window, 0 through 120000. |
| `visual_context_mode` | `text_only` or `text_plus_contact_sheet`. |

## Create Session

`POST /sessions`

```json
{
  "window_id": "my-product:watch",
  "companion": { "id": "companion", "name": "{assistant}" },
  "media": { "...": "see Media Descriptor" },
  "mode": { "...": "see Mode" }
}
```

The server validates the descriptor before creating provider jobs. Session creation establishes the
initial independent client lease. A typical response is:

```json
{
  "ok": true,
  "session": {
    "session_id": "watch_...",
    "window_id": "my-product:watch",
    "media": { "id": "local:...", "source": "local_file", "title": "Example Movie" },
    "mode": { "knowledge_mode": "needs_summary" },
    "state": "preparing"
  }
}
```

Session creation does not unlock playback.

## List Sessions

`GET /sessions?window_id=<id>&limit=20`

Use this for recent/resumable presentation. Hosts should not return ended or lease-expired sessions
as actively synchronized. A client must still fetch status before resuming.

## Client Lease

`POST /sessions/{session_id}/heartbeat`

Request:

```json
{}
```

Response:

```json
{
  "ok": true,
  "client_lease": {
    "client_seen_at": "2026-01-01T00:00:00Z",
    "expires_at": "2026-01-01T00:01:30Z",
    "valid": true
  }
}
```

The server stores this independently from `updated_at`. The reference client heartbeats every 30
seconds against a reference 90-second lease. Hosts may choose different values as long as normal
jitter cannot expire a healthy client.

## Playback Snapshot

`PUT /sessions/{session_id}/playback`

```json
{
  "media_id": "demo:episode-1",
  "playhead_ms": 90000,
  "duration_ms": 1800000,
  "is_playing": true,
  "playback_rate": 1.0,
  "timeline_epoch": 0,
  "snapshot_seq": 1,
  "captured_at": "2026-01-01T00:00:00Z"
}
```

Rules:

- `media_id` must match the active session media.
- `playhead_ms` cannot exceed `duration_ms`.
- `playback_rate` is between 0.25 and 4.0.
- `snapshot_seq` strictly increases inside one epoch.
- A newer epoch invalidates pending old-epoch jobs, plans, actions, and risks.
- An older epoch or non-increasing sequence is ignored/rejected, never applied.
- `captured_at` describes when the player snapshot was captured; it does not replace media time.

For a chat message, capture a fresh snapshot in the same user action and send it with
`watch_session_id`. Do not reuse the last periodic heartbeat snapshot.

## Status

`GET /sessions/{session_id}/status`

The response is intentionally additive. The reference Web client reads these areas when present:

```json
{
  "ok": true,
  "session": { "session_id": "watch_...", "state": "preparing" },
  "client_lease": { "client_seen_at": "...", "expires_at": "...", "valid": true },
  "playback": { "playhead_ms": 90000, "timeline_epoch": 0, "snapshot_seq": 3 },
  "preparation": {
    "stage": "building_card",
    "can_confirm": false,
    "knowledge_card": null,
    "subtitle_status": "searching"
  },
  "analysis": {
    "status": "pending",
    "degraded_reason": "",
    "covered_until_ms": 0
  },
  "start_gate": {
    "status": "buffering",
    "reason": "initial_fear_coverage_pending",
    "can_play": false,
    "can_unlock": false,
    "can_continue_unprotected": true,
    "required_until_ms": 180000,
    "covered_until_ms": 120000
  },
  "sample_plan": null,
  "upcoming_risks": []
}
```

Clients render server truth. `pending`, `degraded`, or `failed` analysis must not be shown as ready
or protected.

## Client Sample Plan

A local session may receive this in status:

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
  "max_frames": 3,
  "audio_required": false,
  "accepted_image_mime_types": ["image/jpeg"],
  "accepted_audio_mime_types": ["audio/mpeg", "audio/aac", "audio/mp4"],
  "expires_at": "2026-01-01T00:15:00Z"
}
```

Purposes are `identify`, `timeline_prepass`, and `rolling`. Client-managed plans require a non-empty
revision and expiry. Frame targets must remain inside the allowed range; the portable core permits at
most eight frames per plan.

Seek, media replacement, revision change, expiry, cancellation, lease expiry, or session end makes
the plan unusable. Processing the same accepted plan again should be idempotent or rejected as
already consumed.

## Upload Client Samples

`POST /sessions/{session_id}/analysis/samples`

Content type is `multipart/form-data`:

- `metadata`: JSON string;
- image fields: sparse frames with their timestamps described in metadata;
- optional audio field: only the approved short range and MIME type.

Example metadata:

```json
{
  "plan_id": "watch_plan_...",
  "media_revision": "sha256-or-host-revision",
  "timeline_epoch": 2,
  "purpose": "rolling",
  "actual_range_start_ms": 930000,
  "actual_range_end_ms": 960000,
  "audio_track_id": "browser-default",
  "samples": [
    {
      "kind": "image",
      "at_ms": 930000,
      "mime_type": "image/jpeg",
      "file_field": "frame_0",
      "captured_at": "2026-01-01T00:15:30Z"
    },
    {
      "kind": "image",
      "at_ms": 945000,
      "mime_type": "image/jpeg",
      "file_field": "frame_1",
      "captured_at": "2026-01-01T00:15:45Z"
    },
    {
      "kind": "image",
      "at_ms": 960000,
      "mime_type": "image/jpeg",
      "file_field": "frame_2",
      "captured_at": "2026-01-01T00:16:00Z"
    }
  ]
}
```

The multipart file fields are `frame_0`, `frame_1`, and `frame_2` in this example. An audio sample
uses `kind: "audio"`, its own `file_field`, one `at_ms`, and an accepted audio MIME type. When audio
is present, `audio_track_id` must match the session's selected audio track. Local plan uploads derive
their idempotency key from `plan_id`; clients do not need to invent one. A host may accept a separate
`idempotency_key` for non-local source uploads.

Before accepting bytes, the host checks session/end state, lease, media ID, revision, epoch, plan
expiry, actual range, count, and MIME type. Before scheduling analysis, it checks them again in the
same transaction that consumes the plan.

The server deletes raw samples after successful commit, cancellation, terminal failure, or session
end. A client deletes its temporary export after the upload outcome.

## Local Subtitle Upload

`POST /sessions/{session_id}/local-subtitles`

```json
{
  "media_revision": "sha256-or-host-revision",
  "format": "srt",
  "track_id": "external-file",
  "subtitle_text": "1\n00:00:01,000 --> 00:00:03,000\nHello\n"
}
```

Language, label, and signed `offset_ms` come from the selected subtitle descriptor on the session.
The host parses SRT/VTT into timed cues and applies the offset once. It rejects a revision mismatch
or a subtitle track different from the session selection.

External subtitle search remains optional. No result is represented as `not_found`; missing provider
configuration is `not_configured`. Neither state should block ordinary playback.

## Preparation Actions

### Regenerate Knowledge Card

`POST /sessions/{session_id}/knowledge-card/regenerate`

Valid only when the session mode requests a background card. This renews the client lease and queues
work only while the lease is valid.

### Retry Network Subtitles

`POST /sessions/{session_id}/subtitles/retry`

Retries the configured provider for the identified work/version. It does not replace a user-selected
local subtitle unless the host explicitly exposes that choice.

### Start Session

`POST /sessions/{session_id}/start`

Normal confirmation:

```json
{
  "knowledge_card_action": "confirm",
  "knowledge_card_key": "card-cache-key-returned-by-status",
  "subtitle_lookup_id": "lookup-id-returned-by-status",
  "protection_action": "wait"
}
```

Skipping a failed/undesired optional knowledge card uses `knowledge_card_action: "skip"`. After the
first accepted confirmation, a fear-mode session may still be locked while initial protection is
prepared. Explicit fear-mode bypass then uses:

```json
{
  "protection_action": "continue_unprotected"
}
```

The server may respond with a locked/buffering gate until minimum initial risk coverage exists. The
client either waits or requires the explicit unprotected action. A timeout or analysis failure must
not be converted silently into protection.

### Update Mode

`PUT /sessions/{session_id}/mode`

```json
{
  "mode": {
    "fear_mode": true,
    "fear_action": "warn_only",
    "danmaku_enabled": true,
    "reply_lead_ms": 90000,
    "visual_context_mode": "text_only"
  }
}
```

Hosts may restrict which fields change after preparation. A change that alters analysis semantics may
need a new epoch or fresh preparation.

## End Session

`DELETE /sessions/{session_id}`

This operation is idempotent and must be one atomic lifecycle transition:

1. mark the session ended;
2. cancel queued/deferred jobs;
3. set `cancel_requested` on running jobs;
4. invalidate open sample plans;
5. remove raw samples and derived visual frames.

If the client cannot send DELETE, lease expiry performs the same abandonment cleanup. Worker startup
must not revive a session whose lease is blank or expired.

## Context Envelope

The host creates model-visible context from a message snapshot:

```json
{
  "session_id": "watch_...",
  "media_id": "demo:episode-1",
  "message_playhead_ms": 90000,
  "reply_arrival_until_ms": 120000,
  "story_background": "optional continuity reference",
  "related_watched_chunks": [],
  "current_chunks": [],
  "reply_arrival_chunks": [],
  "scheduled_future_chunks": []
}
```

- `story_background` appears only under the selected preparation mode.
- `related_watched_chunks` comes only from cached, already watched chunks in this session.
- `current_chunks` intersects the message playhead.
- `reply_arrival_chunks` ends no later than `reply_arrival_until_ms`.
- `scheduled_future_chunks` may drive timed actions but never visible reply prose.

## Plot Chunk

```json
{
  "chunk_id": "chunk_...",
  "session_id": "watch_...",
  "timeline_epoch": 0,
  "start_ms": 85000,
  "end_ms": 102000,
  "summary": "A character notices the missing key and searches the desk.",
  "dialogue_summary": "A asks B who last used the key.",
  "tags": ["missing key", "desk"],
  "characters": ["A", "B"]
}
```

Chunks must be factual, continuous enough to explain what happened, and grounded in available image,
audio, and subtitle evidence. A host may retain them for a short session TTL; 24 hours is a practical
default for resuming the same watch session.

## Risk Event

```json
{
  "risk_id": "risk_...",
  "session_id": "watch_...",
  "timeline_epoch": 0,
  "warn_at_ms": 116000,
  "start_ms": 120000,
  "end_ms": 128000,
  "severity": 0.82,
  "categories": ["jump_scare"]
}
```

`warn_at_ms` cannot be later than `start_ms`. Clients only render confirmed events for the current
session/media/epoch. Dismissing a cover bypasses that event, not the entire mode.

## Timed Danmaku Action

The model-facing intent is deliberately small:

```json
{
  "target_ms": 108000,
  "text": "That explains the earlier clue."
}
```

The trusted host adds:

```json
{
  "action_id": "action_...",
  "session_id": "watch_...",
  "media_id": "demo:episode-1",
  "timeline_epoch": 0,
  "target_ms": 108000,
  "text": "That explains the earlier clue."
}
```

Reject actions for another session/media, an old epoch, a duplicate ID, a target already passed, or
a target outside the host's allowed future window. Deliver through SSE, WebSocket, native callback,
or the reference browser custom event.

## Worker Guard Contract

Work records should carry:

```json
{
  "work_id": "work_...",
  "session_id": "watch_...",
  "media_id": "demo:episode-1",
  "timeline_epoch": 0,
  "status": "running",
  "cancel_requested": false,
  "lease_token": "worker-opaque-token"
}
```

The scheduler and worker both check client liveness. The worker guards after claim, around source and
provider operations, and before commit. Valid skip reasons are:

- `session_ended`;
- `client_lease_expired`;
- `cancel_requested`;
- `stale_timeline`;
- `lease_lost`.

## Versioning and Compatibility

- Additive response fields are backward compatible.
- Removing/renaming fields, changing enum meaning, or weakening timeline checks requires a protocol
  version change.
- Clients should expose their capabilities instead of inferring support from platform name.
- Hosts should return stable machine-readable error codes and a human-readable `error` string.
- Retry endpoints and DELETE should be idempotent where practical.
