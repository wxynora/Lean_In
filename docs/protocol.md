# Protocol v1

The protocol uses media time in milliseconds. JSON examples are transport-neutral; route names,
SSE event names, and model tool syntax belong to host adapters.

## Playback Snapshot

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

Within one epoch, `snapshot_seq` increases monotonically. A seek, media replacement, or recovery
that invalidates pending actions creates a newer epoch. Older epochs and non-increasing sequence
numbers are ignored.

## Client Capabilities

```json
{
  "playback_snapshot": true,
  "local_media": false,
  "client_sampling": false,
  "danmaku_overlay": true,
  "risk_overlay": true,
  "visual_context": true
}
```

`playback_snapshot` is required. All other capabilities can degrade independently.

## Context Envelope

The core returns separate fields for:

- `story_background`: optional, only for a host-selected summary mode;
- `related_watched_chunks`: related plot that ended before the message playhead;
- `current_chunks`: plot visible at the message playhead;
- `reply_arrival_chunks`: limited future plot expected to play before the reply arrives;
- `scheduled_future_chunks`: later plot that can only drive timed actions;
- `reply_arrival_until_ms`: the hard visible-reply boundary.

The host must not place `scheduled_future_chunks` in visible reply context.

## Timed Danmaku Action

Model-facing hosts should prefer a native tool with two arguments:

```json
{
  "target_ms": 108000,
  "text": "That explains the earlier clue."
}
```

The host adapter adds session, media, epoch, and a deterministic action ID. The core rejects actions
for another media item, an old epoch, an expired target, or a target outside the allowed future
window.

## Local Media Sampling

For local media, a service may return a client-managed sample plan. The plan identifies purpose,
epoch, time range, frame limit, and accepted audio/image formats. It never contains a local path.
The client exports through a separate media reader and must not seek the actively playing player.
