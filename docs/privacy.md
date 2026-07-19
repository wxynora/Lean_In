# Privacy and Media Boundaries

TogetherWatch is designed to analyze short media windows without turning a co-watching feature into
a full-file upload service. This document defines the minimum boundary for any compatible host.

## Data Classes

| Data | Typical location | Retention expectation |
| --- | --- | --- |
| Original local video | User device only | Controlled by the user; never uploaded by TogetherWatch. |
| Local path, file handle, blob URL | Client process only | Destroy when the local session ends. |
| Sparse frames / short audio | Client temporary memory, then host temporary storage | Delete after commit, cancellation, terminal failure, or session end. |
| Subtitle text and timed cues | Host session storage | Session-scoped; expire with the watch cache. |
| Work-background card | Host session/cache storage | Keep only as long as needed for the selected work/session policy. |
| Plot chunks and rolling story state | Host session storage | Short-lived; 24 hours is a practical resume TTL. |
| Risk events and timed actions | Host session storage/client memory | Delete on epoch invalidation, session end, or TTL expiry. |
| Playback snapshots | Host runtime storage | Keep only what synchronization and diagnostics require. |
| Chat messages | Host chat system | Governed by the host, not by TogetherWatch core. |
| Provider credentials | Backend secret store | Never expose to the browser or public repository. |

## Local Media Boundary

The session protocol contains a random `local_asset_id` and a content-sensitive `media_revision`.
It must not contain:

- the original filesystem path;
- a browser `blob:` URL;
- a platform content URI;
- a persistent file handle;
- storage-provider account metadata;
- the complete media bytes.

The revision is for cache safety, not content identification across users. A public deployment should
avoid using a hash of the complete file as a globally queryable identifier. The reference Web client
combines local file metadata with sparse bytes and keeps the result inside the session request.

## Sample Authorization

A client uploads samples only after receiving a short-lived plan containing:

- session and media ID;
- media revision;
- timeline epoch;
- analysis purpose;
- target timestamps and allowed range;
- frame/audio constraints;
- expiry time.

The client must use a second reader so sampling cannot move the visible player. The host validates the
plan before accepting material and again before consuming it. A seek, media replacement, end request,
lease expiry, or plan expiry invalidates all older material.

Do not request or retain broader windows merely because local access is available. The plan should be
the smallest useful input for the next identification, prepass, or rolling analysis task.

## Capability Honesty

The client reports what it can actually do:

- playback and seek;
- random future reads;
- frame export;
- audio export from the selected track;
- audio presence;
- DRM status.

A playable file is not automatically sampleable. If sampling is unavailable, ordinary playback may
continue, but rolling plot analysis and fear protection must be visibly unavailable. If only frames
or subtitles are available, label the analysis degraded instead of inventing audio evidence.

## Subtitle Handling

For a user-selected local SRT/VTT file, send only subtitle text plus track, language, format, revision,
and alignment metadata. The original media file remains local.

Subtitles assist interpretation. They may be offset, translated, edited, or belong to another cut, so
analysis should prioritize actual image/audio evidence when they conflict. External subtitle search
providers receive only the work/version metadata required for lookup.

## Provider Requests

Analysis providers should receive only the material required for the current batch:

- authorized sparse frames;
- an authorized short audio window when available;
- matching subtitle cues;
- prior rolling story state;
- an optional work-background card when the user selected that mode.

Do not include private companion names, relationship prompts, unrelated chat history, global memory,
local paths, cookies, or source-site login state in an analysis/knowledge/subtitle request.

Provider prompts should use generic terms such as viewer and companion. Private product-specific chat
context is added only by the host's visible-reply adapter, after the media-analysis boundary.

## Future Plot Boundary

The host separates current/reply-arrival plot from later scheduled-future plot. Future-only material:

- may schedule a validated timed warning or danmaku action;
- must not be inserted into visible model replies;
- must not be written into long-term chat memory;
- must be invalidated when the timeline epoch changes.

This is both a spoiler boundary and a data-minimization boundary.

## Session-Only Recall

Related-plot recall searches only chunks that:

- belong to the active watch session;
- match the current media and timeline epoch;
- are already cached;
- ended before the viewer's message position.

It is not a query over the user's long-term memory or all prior chats. Downstream hosts may replace
the ranking algorithm, but must preserve the candidate boundary.

## End, Expiry, and Deletion

Explicit `DELETE /sessions/{id}` atomically marks the session ended, cancels queued work, requests
cancellation of running work, invalidates sample plans, and purges temporary samples/visual frames.

When DELETE cannot arrive because the client crashed or lost network, the independent client lease
provides the same abandonment boundary. Schedulers stop creating work after expiry. Workers recheck
the session around every expensive operation and before commit. Worker restart scans must not revive
blank-lease or expired sessions.

Storage implementations should make cleanup retryable and idempotent. A failed object deletion may be
retried, but it must not make the ended session schedulable again.

## Browser and Source Credentials

- Never put model, subtitle-provider, storage, or search-provider secrets in `web/config.js`.
- `getAuthHeaders` should return a short-lived user/session credential issued by the host.
- Configure CORS only for intended Web origins and required methods/headers.
- Keep Bilibili/source-site cookies inside the playback/source adapter.
- Do not proxy a user's authenticated player cookies to analysis providers.
- The reference browser client cannot inspect a cross-origin official iframe; use a trusted host
  adapter rather than weakening browser isolation.

## Logs and Diagnostics

Safe operational logs include:

- opaque session/work IDs;
- state transitions;
- media time ranges;
- capability/degradation states;
- skip reasons such as `session_ended` or `client_lease_expired`;
- provider latency and usage after a real call.

Avoid logging:

- authorization headers or provider keys;
- subtitle bodies or dialogue text;
- frame/audio bytes or data URLs;
- full chat messages;
- local filenames or paths;
- cookies and source login state.

## Deployment Checklist

- [ ] Full local media never leaves the device.
- [ ] Plans are range-limited, revision-aware, epoch-aware, and expiring.
- [ ] Raw samples are deleted on success, cancellation, failure, seek, end, and TTL expiry.
- [ ] Client liveness is separate from general row updates.
- [ ] Every scheduler and provider boundary checks end/lease/cancellation/timeline state.
- [ ] Unknown and degraded states are visible to the user.
- [ ] Provider credentials remain server-side.
- [ ] Future plot cannot enter visible replies or long-term memory.
- [ ] Recall is limited to already watched chunks in the active session.
- [ ] Logs omit sensitive payloads and credentials.
