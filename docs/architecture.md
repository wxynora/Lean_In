# Architecture

TogetherWatch separates deterministic co-watching behavior from platform and provider details.

## Portable Core

The core owns:

- watch sessions and media identity;
- playback snapshot validation;
- timeline epochs after seek or recovery;
- reply-arrival and scheduled-future windows;
- active-session plot recall;
- risk-event and timed-action validation;
- provider-neutral adapter contracts.

The core does not own a video player, UI toolkit, chat model, model prompt, HTTP framework, or
database engine.

## Adapters

| Adapter | Responsibility |
| --- | --- |
| `PlaybackAdapter` | Return authoritative media snapshots and seek/media-change events. |
| `ClientSampleExporter` | Optionally export short audio windows and sparse frames from local media. |
| `AnalysisProvider` | Convert audio, frames, subtitles, and prior state into plot and risk events. |
| `KnowledgeProvider` | Optionally prepare a pre-play work background card. |
| `SubtitleProvider` | Resolve and normalize an optional subtitle track. |
| `PlotRecallAdapter` | Retrieve related chunks from the active session only. |
| `ContextHostAdapter` | Convert a context envelope into the host model's request format. |
| `ActionTransport` | Deliver normalized timed actions to a client. |
| `RuntimeStore` | Persist short-lived sessions, chunks, risks, and idempotency records. |

## Client Capabilities

Only authoritative playback snapshots are mandatory. Local media, client-side sampling, visual
context, danmaku overlays, and risk-cover overlays are optional capabilities. Missing capabilities
must produce explicit degradation rather than simulated success.

## Deployment Shapes

1. **Standalone service**: a backend exposes the protocol over HTTP/JSON and an event stream.
2. **Embedded core**: an existing chat backend imports the package and supplies adapters directly.

Neither shape requires Android. Browser, desktop, iOS, Android, and headless test clients can use
the same protocol.
