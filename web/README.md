# TogetherWatch Web Client

This directory contains a functional, framework-free browser reference client. It is not a static
mock: when connected to a compatible gateway it creates and ends real sessions, renews the client
lease, synchronizes playback snapshots, renders real preparation states, submits local subtitles,
executes client sample plans, displays confirmed risk windows, and hands chat messages to the host.

The UI remains a reference implementation. Product teams may port the same contracts to React,
Vue, iOS, Android, desktop, or another player without copying this presentation layer.

## Run Locally

Serve the repository over HTTP; browser modules and local video APIs should not be opened through a
plain `file://` URL.

```bash
cd ..
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080/web/`.

## Gateway Configuration

Edit `config.js`:

```js
globalThis.TogetherWatchConfig = {
  gatewayBaseUrl: "https://gateway.example.com",
  watchApiBasePath: "/miniapp-api/watch",
  windowId: "my-product:watch",
  companion: { id: "companion", name: "{assistant}" },
  heartbeatIntervalMs: 30_000,
  playbackSyncIntervalMs: 2_000,
  statusPollIntervalMs: 2_000,
  getAuthHeaders: async () => ({
    Authorization: `Bearer ${await obtainShortLivedToken()}`,
  }),
};
```

| Field | Meaning |
| --- | --- |
| `gatewayBaseUrl` | Empty for same-origin requests, or an absolute gateway origin. |
| `watchApiBasePath` | Route prefix implementing the reference gateway contract. |
| `windowId` | Stable host conversation/window identifier used to list sessions. |
| `companion` | Public companion identifier and display name sent during session creation. |
| `heartbeatIntervalMs` | Explicit lease-renewal cadence; keep it shorter than the server lease. |
| `playbackSyncIntervalMs` | Playback snapshot cadence. |
| `statusPollIntervalMs` | Preparation, plan, analysis, and risk refresh cadence. |
| `getAuthHeaders` | Async function returning current request headers. Do not place durable secrets in this repository. |

For cross-origin gateways, configure CORS for the Web origin, required methods, and authentication
headers. Production authentication should use short-lived user/session credentials, not provider API
keys in browser JavaScript.

## Host Adapter

The gateway handles watch state, but two capabilities belong to the embedding product:

1. Bilibili playback snapshots, because browser code cannot read the cross-origin official iframe.
2. Real chat submission, because every product has a different chat/SSE protocol.

Expose them as `globalThis.TogetherWatchHost` before `app.js` loads:

```js
globalThis.TogetherWatchHost = {
  async getPlaybackSnapshot({ session_id, media }) {
    return {
      media_id: media.id,
      playhead_ms: player.currentTimeMs(),
      duration_ms: media.duration_ms,
      is_playing: player.isPlaying(),
      playback_rate: player.playbackRate(),
      timeline_epoch: player.timelineEpoch(),
      snapshot_seq: player.nextSnapshotSequence(),
      captured_at: new Date().toISOString(),
    };
  },

  async sendMessage({ text, watch_session_id, watch_snapshot }) {
    return chatClient.send({
      text,
      watch_session_id,
      watch_snapshot,
    });
  },

  async openChat() {
    router.openChat();
  },
};
```

`getPlaybackSnapshot` is required only for Bilibili/other cross-origin players. Local files use the
native `<video>` media clock directly. `sendMessage` is required to enable the chat input. If it is
absent, playback and analysis remain functional and the UI states clearly that chat is not connected;
it does not fabricate replies.

## Local Video Flow

The browser client performs these steps:

1. The selected file becomes a local object URL; the complete file is never posted to the gateway.
2. Metadata is loaded and playback/seek/frame-export capability is tested.
3. A random `local_asset_id` is generated.
4. `media_revision` is derived from file metadata and sparse bytes from the beginning, middle, and
   end of the selected file. Replacing a file therefore does not silently reuse old plot caches.
5. The visible player remains paused during preparation.
6. A second hidden `<video>` element seeks to timestamps authorized by a server `plan_id` and exports
   sparse JPEG frames. The visible player is never moved by analysis sampling.
7. The plan ID, revision, epoch, actual range, frame timestamps, and expiry are checked by the
   gateway before the job is accepted.

The browser posts `multipart/form-data` to `/sessions/{id}/analysis/samples`. Its `metadata` JSON
contains `plan_id`, `media_revision`, `timeline_epoch`, `purpose`, `actual_range_start_ms`,
`actual_range_end_ms`, `audio_track_id`, and a `samples` array. Each sample names its multipart
`file_field`, media timestamp, kind, MIME type, and capture time. Exact payloads and invalidation rules
are in the [protocol document](../docs/protocol.md#upload-client-samples).

The browser implementation reports `can_export_audio=false`. It therefore runs frame-only analysis
when the gateway permits an honest degradation. Native/desktop hosts can implement short audio
export for the selected audio track and use the same multipart endpoint.

### Local Subtitles

The page accepts optional SRT or VTT files plus a signed millisecond offset. Only subtitle text and
alignment metadata are submitted. The original video is not uploaded.

If no subtitle is selected, the session continues with audio/frames according to available
capabilities. Subtitle absence is a visible degradation, not a preparation failure.

## Bilibili Flow

The client accepts a full Bilibili URL or BV ID and asks the gateway for real title, duration, and
all part metadata. Every part receives its own media ID and session; selecting another part ends the
old session before starting the new one.

Short `b23.tv` links must be resolved by the embedding host before setup. More importantly, the
official Bilibili iframe is cross-origin, so ordinary Web code cannot read its current time, pause
state, speed, or seek events. The client refuses to pretend otherwise and requires
`TogetherWatchHost.getPlaybackSnapshot` for Bilibili mode.

## Preparation and Playback

The page polls `GET /sessions/{id}/status` and renders the server response directly:

- work recognition;
- background-card collection and the final visible card;
- subtitle lookup or local subtitle status;
- analysis degradation;
- visual-context availability;
- initial fear-protection coverage;
- `sample_plan` for local client sampling.

The confirm button is enabled only when the server returns `preparation.can_confirm`. If fear mode
is enabled and initial protection is not ready, the player remains locked. The user can wait for
coverage or choose the explicit “continue without protection” action. Status polling unlocks the
player as soon as `start_gate.can_play=true`; it does not call `/start` a second time. The client
never labels pending/degraded/failed analysis as protected.

## Chat Events

`TogetherWatchHost.sendMessage` receives a playback snapshot captured with the user message. It may
return either:

```js
{ assistant_text: "..." }
```

or:

```js
{ messages: [{ role: "assistant", content: "..." }] }
```

Streaming hosts can deliver later visible messages with:

```js
window.dispatchEvent(new CustomEvent("togetherwatch:message", {
  detail: {
    session_id: "watch_...",
    role: "assistant",
    speaker: "{assistant}",
    text: "...",
  },
}));
```

## Timed Danmaku Events

After validating either a model tool call or a parsed hidden marker, dispatch the same client event:

```js
window.dispatchEvent(new CustomEvent("togetherwatch:danmaku", {
  detail: {
    action_id: "action_...",
    session_id: "watch_...",
    media_id: "local:...",
    timeline_epoch: 2,
    target_ms: 930000,
    text: "That clue connects now.",
  },
}));
```

The client rejects another session/media/epoch, duplicate IDs, stale targets, and targets more than
two media minutes ahead. Accepted actions stay bound to media time, so pause does not consume their
delay.

## Fear-Mode Events

Risk events come from `status.upcoming_risks`. The client only reacts to confirmed server events and
uses `warn_at_ms`, `start_ms`, and `end_ms`. `warn_only` shows a warning; `cover_video` places a
locally dismissible cover above the picture. The bypass applies to that risk event only.

## Session End and Failure Recovery

The player top-bar back action, the return-to-setup menu action, and browser/system history back all
call `DELETE /sessions/{id}` before returning to setup. Switching parts also ends the old session
before creating the next one. Each successful DELETE response contributes its `analysis_cost` once,
keyed by session ID. Part switches accumulate silently; normal return and end flows show the total
plot-analysis cost across the parts watched in that run. Incomplete totals never present an unknown
zero as free usage, and a failed DELETE does not invent a cost.

The setup-page back action is handed to the embedding host through `togetherwatch:back`. `pagehide`
only makes a best-effort DELETE call and never opens the cost dialog. If a browser process is killed
or the network disappears before DELETE arrives, heartbeats stop and the independent server lease
must end the session and cancel new work.

The server remains responsible for atomic queued/running cancellation and temporary sample cleanup;
the browser lease is not a substitute for that transaction.

## API Methods Used

The client implementation in `lib/api.js` calls:

```text
GET    /sessions
POST   /sessions
GET    /sessions/{id}/status
POST   /sessions/{id}/heartbeat
PUT    /sessions/{id}/playback
POST   /sessions/{id}/start
PUT    /sessions/{id}/mode
POST   /sessions/{id}/knowledge-card/regenerate
POST   /sessions/{id}/subtitles/retry
POST   /sessions/{id}/local-subtitles
POST   /sessions/{id}/analysis/samples
DELETE /sessions/{id}
GET    /bilibili/parts
```

See the root [README](../README.md) and [protocol document](../docs/protocol.md) for payloads and
worker-side requirements.

## JavaScript Tests

```bash
npm test
```

The tests cover Bilibili reference parsing, media boundaries, random local asset IDs,
content-sensitive media revisions, epoch/sequence behavior, stale client-plan rejection before frame
reads, configurable API URLs and headers, and structured gateway errors.
