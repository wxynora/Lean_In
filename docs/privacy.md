# Privacy and Media Boundaries

TogetherWatch is designed around short-lived analysis material.

- Full local media stays on the user's device.
- A client-managed sampler uploads only the server-approved short audio window and sparse frames.
- Local file handles, paths, blob URLs, and storage-provider metadata never enter the protocol.
- Raw samples should be deleted after successful analysis, cancellation, or final failure.
- Derived low-resolution frames and plot chunks should expire with the active session TTL.
- Future plot, risk predictions, and visual context must not enter long-term chat memory.
- Player cookies and login state stay inside the playback adapter.
- Public repositories and tests use synthetic metadata only.

An integration must communicate when analysis, visual context, or risk protection is unavailable.
Playback may continue, but the UI must not claim that protection or synchronization is ready.
