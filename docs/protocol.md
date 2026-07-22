# Protocol v1

Lean In uses media time in integer milliseconds. JSON field names are stable public-contract
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
  "work_key": "movie:example-work",
  "cover_url": "https://example.invalid/cover.jpg",
  "part_title": "Episode 1",
  "part_key": "episode-1",
  "part_index": 1,
  "part_count": 1,
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
  "idempotency_key": "create-attempt-opaque-id",
  "viewing_id": "",
  "window_id": "my-product:watch",
  "companion": { "id": "companion", "name": "{assistant}" },
  "media": { "...": "see Media Descriptor" },
  "mode": { "...": "see Mode" }
}
```

The server validates the descriptor before creating provider jobs. Session creation establishes the
initial independent client lease. The client should send a stable `idempotency_key` for one create
attempt. Repeating the same key with the same media, mode, and capabilities returns the existing
active session; reusing it with different data is rejected. The uniqueness check and insert must be
one transaction so a timeout/retry cannot create two preparation pipelines. A typical response is:

```json
{
  "ok": true,
  "session": {
    "session_id": "watch_...",
    "window_id": "my-product:watch",
    "media": { "id": "local:...", "source": "local_file", "title": "Example Movie" },
    "mode": { "knowledge_mode": "needs_summary" },
    "state": "preparing",
    "create_reused": false
  },
  "viewing_summary": {
    "viewing_id": "watch_viewing_...",
    "work_key": "movie:example-work",
    "completed": false,
    "ticket": null
  }
}
```

Session creation does not unlock playback.

## List Sessions

`GET /sessions?window_id=<id>&limit=20`

Use this only for active session recovery. Hosts must not return ended or lease-expired sessions as
actively synchronized.

## List Saved Progress

`GET /viewings?window_id=<id>&status=resumable`

This returns saved `viewing_progress` records for Recent Watch. It is separate from active-session
recovery and from the completed ticket shelf. A saved record keeps its `viewing_id`, selected part,
authoritative playhead, trusted played duration, analysis coverage, and any explicitly selected
ticket-back frame.

To resume, create a new session with the saved `viewing_id` and the same `work_key` and part identity.
The host reattaches the retained plot chunks, risks, knowledge card, and subtitle reference to that
new session. Raw audio, raw frames, and contact sheets are not retained for resume. A local-file
client must reselect the file and prove the same `media_revision`; the host must reject a replacement
file rather than reuse the old analysis.

In the Python reference, pass the same `WatchCore` instance as
`ViewingLedger(analysis_retention=watch_core)`. Saving progress calls
`retain_viewing_analysis(viewing_id, session_id)` and registration of the resumed session calls
`restore_viewing_analysis(viewing_id, new_session_id)`. A persistent host implements the same two
operations in its runtime store. If no retention store is connected, the response must report
`analysis_retained=false` and zero retained coverage instead of returning a marker that has no cache
behind it.

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
- A newer epoch invalidates pending old-epoch jobs, plans, actions, and delivery state.
- An older epoch or non-increasing sequence is ignored/rejected, never applied.
- `captured_at` describes when the player snapshot was captured; it does not replace media time.

Completed plot chunks, confirmed risks, and coverage may be reused across epochs when `media_id`
and, for local media, `media_revision` are unchanged. Re-associate those rows with the new epoch
before exposing them; never expose old-epoch actions directly. The scheduler begins after reusable
cached coverage instead of paying to analyze the same media interval again.

Viewer-supplied timeline corrections are approximate sampling references. Replacing such references
may cancel unfinished sampling for the affected epoch, but must not delete completed plot chunks,
risks, checkpoints, usage, or coverage. A reference alone never proves that an interval was analyzed
and therefore cannot advance `covered_until_ms`.

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
    "reason": "initial_analysis_coverage_pending",
    "can_play": false,
    "can_unlock": false,
    "can_continue_unprotected": false,
    "required_until_ms": 390000,
    "covered_until_ms": 210000
  },
  "sample_plan": null,
  "upcoming_risks": []
}
```

Clients render server truth. `pending`, `degraded`, or `failed` analysis must not be shown as ready
or protected.

## Server-side Network Source Sampling

A host that samples a network-accessible source resolves fresh signed stream URLs once per analysis
batch and processes frame timestamps in media-time order. A successful backup URL is promoted for
the rest of that batch. When all candidates fail at one timestamp, the host refreshes the signed URLs
and retries only that timestamp once; previously captured frames stay intact. Per-candidate fallback
is non-alerting. Only failure after the fresh resolution is a terminal source-sampling failure.

The portable `sample_frames_with_refresh()` helper owns this ordering but not provider HTTP calls or
media decoding. For Bilibili, the recommended low-cost resolver requests 480P (`qn=32`) DASH and
prefers AVC before exposing the selected representation's primary and backup URLs to the helper.
Hosts must not expose or log signed URLs, cookies, or source request headers.

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

TMDB is an optional identity resolver for a user-triggered retry, not a required subtitle source.
The ordinary lookup first tries the identified original and localized titles against the configured
subtitle provider. Only after that lookup reaches `not_found` or `failed` and the viewer explicitly
retries may a host with `tmdb_identity.enabled=true` resolve a unique movie/TV ID and retry the
subtitle provider by ID. The read-access token stays in the server environment named by
`read_access_token_env`; it is never returned to the client. Missing TMDB configuration remains
`not_configured` and does not disable title lookup, local subtitles, or playback.

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
first accepted confirmation, every session remains locked while the initial analyzed plot range is
prepared. Hosts should default this range to five media minutes (`300000` ms), clamped to the actual
content end. Explicit fear-mode bypass uses:

```json
{
  "protection_action": "continue_unprotected"
}
```

The server responds with a locked/buffering gate until minimum initial plot coverage exists. Ordinary
mode always waits. Fear mode may additionally offer the explicit unprotected action; a timeout or
analysis failure must not be converted silently into plot readiness or protection.

When a committed analysis result reaches `required_until_ms`, the same storage transaction persists
the playback unlock. Subsequent status responses return `start_gate.status=ready` and
`start_gate.can_play=true`; clients do not call the start endpoint again. Once persisted, later
rolling work cannot move the gate back to buffering.

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

The successful response includes the analysis-model cost reported for this session:

```json
{
  "ok": true,
  "session": { "session_id": "watch_...", "state": "ended" },
  "analysis_cost": {
    "currency": "USD",
    "amount_usd": 0.0124,
    "complete": true,
    "pricing_complete": true,
    "provider_calls": 6,
    "priced_calls": 6,
    "unpriced_calls": 0,
    "pending_jobs": 0,
    "input_tokens": 18200,
    "output_tokens": 3100,
    "breakdown": {
      "rolling": {
        "amount_usd": 0.0124,
        "provider_calls": 6,
        "priced_calls": 6,
        "unpriced_calls": 0,
        "input_tokens": 18200,
        "output_tokens": 3100
      }
    }
  },
  "viewing_summary": {
    "viewing_id": "watch_viewing_...",
    "completed": true,
    "played_duration_ms": 6543000,
    "ticket": { "$ref": "viewingTicket example below" }
  },
  "ticket": { "$ref": "viewingTicket example below" }
}
```

This ledger includes real provider calls for `identify`, `timeline_prepass`, `rolling`,
`knowledge_card`, and `subtitle_lookup`. Local cache/fingerprint reuse has no provider call and adds
no cost. `complete=false` means work is still queued/running. `pricing_complete=false` means at least
one completed provider call did not return a USD price; `unpriced_calls` makes that gap explicit.
Clients must not present an unpriced or incomplete zero as free usage.

Record each provider event idempotently immediately after the response arrives, before checking
whether the session ended or the epoch changed. A stale result is still rejected, but a real call is
not erased from the ledger. Retries use distinct event keys, while replaying the same completion does
not double count it.

If the client cannot send DELETE, lease expiry performs the same abandonment cleanup. Worker startup
must not revive a session whose lease is blank or expired.

Technical cleanup, saving progress, and completing a viewing are three different transitions:

| Request | Meaning |
| --- | --- |
| `DELETE /sessions/{id}` | Technical cleanup for part switching, `pagehide`, or abandonment. It creates neither saved progress nor a ticket. |
| `DELETE /sessions/{id}?viewing_action=save_progress` | Close the session, retain resumable plot analysis and the authoritative playback point, and create no ticket. |
| `DELETE /sessions/{id}?viewing_action=complete` | Clear resumable progress and create or return one stable ticket. |

`save_progress` returns `viewing_summary.progress` and may also expose it as top-level
`viewing_progress`. `complete` returns `viewing_summary.ticket` and may also expose it as top-level
`ticket`. Repeating `complete` must return the same ticket and must not restart any retention clock.
The old `finalize_viewing=true` query may be accepted by a host as a temporary compatibility alias
for `viewing_action=complete`, but new clients should use the explicit action.

## Viewing Completion and Ticket Shelf

The first part may omit `viewing_id`; the host creates one and returns it in `viewing_summary`.
Subsequent parts use separate sessions but reuse that `viewing_id`, the same `work_key`, and truthful
`part_key`, `part_index`, and `part_count` values.

The host records trusted played time only between adjacent snapshots when the previous snapshot was
playing in the same timeline epoch. The increment is the smaller of server-observed elapsed time and
media movement divided by the previous playback rate. Pause, preparation, and seek jumps therefore
do not inflate the ticket duration.

`content_end_ms` is the viewer-supplied normal-content end, commonly the beginning of credits or the
ending song. When it is absent, the media duration is the completion boundary. Reaching the boundary
after playback unlock plus either same-epoch trusted playback or explicit `media_ended=true` marks
that part complete. It is not a ticket gate and it does not need to include filler appended after the
real program.

The host persists one stable ticket when an explicit `viewing_action=complete` DELETE is received. The
ticket records the actual trusted playback accumulated before that action. `viewing_summary.completed`
separately reports whether every required part reached its normal-content boundary:

```json
{
  "ticket_id": "watch_ticket_...",
  "viewing_id": "watch_viewing_...",
  "work_key": "movie:example-work",
  "title": "Example Work",
  "cover_url": "https://example.invalid/cover.jpg",
  "companion": { "id": "companion", "name": "{assistant}" },
  "created_at": "2026-01-01T02:03:04Z",
  "completed_at": "2026-01-01T02:03:04Z",
  "played_duration_ms": 6543000,
  "part_count": 1,
  "completed_parts": [
    {
      "part_key": "episode-1",
      "media_id": "bilibili:BV...:p1",
      "part_index": 1,
      "part_title": "Episode 1",
      "played_duration_ms": 6543000,
      "completed_at": "2026-01-01T02:03:04Z",
      "completion_event_id": "watch_completion_...",
      "last_session_id": "watch_..."
    }
  ],
  "last_session_id": "watch_...",
  "back_frame": null
}
```

Recommended host routes:

- `GET /viewings?status=resumable&window_id=...` returns saved progress ordered newest first;
- `GET /viewings/{viewing_id}` returns `viewing_summary` for recovery;
- `POST/GET /viewings/{viewing_id}/ticket-frame-captures` saves or lists user-confirmed JPEG
  captures from every part of the viewing;
- `GET /viewings/{viewing_id}/ticket-frame-captures/{capture_id}/image` reads one authenticated
  persistent capture;
- `PUT /viewings/{viewing_id}/ticket-frame` selects one candidate frame already produced for that
  viewing; `DELETE` on the same route clears it;
- `GET /tickets` returns finalized viewing tickets ordered newest first;
- `PUT /tickets/{ticket_id}` with `{ "title": "Edited title" }` saves a ticket title;
- successful playback/status/DELETE responses include additive `viewing_summary` fields;
- plain `DELETE /sessions/{id}` is for part switching, pagehide, and abandoned-session cleanup;
- `viewing_action=save_progress` retains resumable state without creating a ticket;
- `viewing_action=complete` creates the stable ticket even when
  `viewing_summary.completed=false`.

Saved progress and completed-viewing retention are intentionally different. Saved progress retains
the committed plot analysis needed to resume; it is not converted into a completed-analysis TTL.
When `viewing_action=complete` is accepted, resumable progress is removed and committed plot analysis
enters the host's completed-analysis TTL. The reference default is 24 hours
(`86400` seconds), configurable through `ViewingLedger(completed_analysis_ttl_seconds=...)` or an
equivalent host setting. The response exposes `completed_analysis_cache_expires_at`. The ticket,
the current back-frame selection, and user-confirmed capture collection survive that expiry, while
plot chunks, risks, subtitle working data, and other analysis cache may be deleted. Raw audio, raw
analysis frames, and contact sheets are still removed during every session end and are never
extended by either action.

When visual analysis has produced reusable frames, status may include:

```json
{
  "ticket_frame_candidates": [
    {
      "frame_id": "frame_...",
      "media_id": "bilibili:BV...:p1",
      "at_ms": 125000,
      "image_url": "https://host.example/private/watch-frames/frame_...",
      "selected_at": ""
    }
  ]
}
```

Candidate URLs may be short-lived. Selecting one tells the host to retain exactly that automatic
analysis frame as the ticket back; all unselected analysis frames still follow normal cleanup.

User-confirmed screenshots use a separate viewing-level upload and never enter analysis sample
endpoints. `POST /viewings/{viewing_id}/ticket-frame-captures` is
`multipart/form-data` with an `image` JPEG file and JSON `metadata`:

```json
{
  "session_id": "watch_...",
  "media_id": "bilibili:BV...:p1",
  "timeline_epoch": 2,
  "at_ms": 45000,
  "width": 1280,
  "height": 720,
  "mime_type": "image/jpeg"
}
```

The host authenticates the viewing owner, verifies that the session belongs to that viewing, and
matches media and current timeline epoch. It decodes the file to verify real JPEG content and exact
pixel dimensions before persistence. The response is `{ "ok": true, "capture": ... }`; list
responses are `{ "ok": true, "captures": [...] }`, with stable save ordering. Every capture has
`frame_id`, `media_id`, `at_ms`, `width`, `height`, `mime_type`, and an authenticated `image_url`.

Store captures as independent rows keyed by `viewing_id`, with session/media/epoch provenance,
file path or object key, SHA-256, and creation time. Do not foreign-key their lifetime to a session.
Part switching, technical cleanup, save progress, completion, and completed-analysis TTL cleanup do
not delete them. `PUT /viewings/{viewing_id}/ticket-frame` accepts `{ "capture_id": "capture_..." }`
without requiring an active session, verifies ownership within the viewing, and updates both the
current back-frame selection and any existing ticket. `DELETE` clears only that selection; it does
not delete the capture collection. Capture image responses use the stored MIME type and cacheable
HTTP headers while retaining normal viewing authorization.

The protocol has no personal-watchlist or private-product archive integration.

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

The package includes `build_companion_context_prompt()` as a host-side placeholder renderer for this
envelope. It produces a Chinese dynamic system message using `{assistant}`, `{viewer}`, and `{work}`.
The renderer is deliberately separate from personality or relationship prompts. A host may translate
or replace the template while preserving the same time boundaries.

When visual context is enabled, add the contact sheet as a separate user image content block labeled
`【剧情画面】` immediately before the real viewer message. Images do not change the visible-reply and
scheduled-future time boundaries above.

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

The model-facing intent is deliberately small. A host with native tool support may expose:

```json
{
  "target_ms": 108000,
  "text": "That explains the earlier clue."
}
```

A host without suitable tool-call support may request the equivalent hidden marker:

```text
[watch:danmaku 01:48 That explains the earlier clue.]
```

`MM:SS` and `HH:MM:SS` are accepted media clocks. `split_danmaku_markers()` removes complete markers
from the reply and returns provider-neutral intents; `visible_danmaku_stream_text()` also hides a
partial marker tail during streaming. Invalid or unclosed marker content is hidden and does not
produce an action. The marker name may be changed by the host, but it must not carry trusted session,
media, or epoch values supplied by the model.

Both adapters then enter the same validation path. The trusted host adds:

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
or the reference browser custom event. Hidden marker text must not be shown or written into visible
assistant history.

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

An active session must not be stopped solely because its lifetime count of analysis jobs reaches a
fixed constant. Long media naturally needs more rolling batches. A daily-cost threshold must not
silently defer an active session either; expose real usage to the host and viewer. Hosts should bound
work with the client lease, cancellation state, and authorized timeline ranges.

The initial playback gate and rolling prefetch use separate coverage targets. The gate requires five
minutes of reliable coverage. After unlock, schedule full batches toward the earlier of 30 minutes
ahead or `content_end_ms`. At the high-water mark, wait until at least one full batch has been consumed
before scheduling another. Only the final batch ending at `content_end_ms` may be shorter than the
normal batch span; uploader-added post-credit padding is outside the authorized story range.

## Versioning and Compatibility

- Additive response fields are backward compatible.
- Removing/renaming fields, changing enum meaning, or weakening timeline checks requires a protocol
  version change.
- Clients should expose their capabilities instead of inferring support from platform name.
- Hosts should return stable machine-readable error codes and a human-readable `error` string.
- Retry endpoints and DELETE should be idempotent where practical.
