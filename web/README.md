# Web UI Reference

This directory is a visual and structural reference for TogetherWatch clients. It mirrors the
two-stage product flow without containing the private Android application or its Compose source.

The reference is intentionally a draft. Its layout may be updated later to follow changes made in
the private product UI; downstream clients should treat the protocol documents, not pixel details,
as the stable contract.

It is not a production Web client and does not call a model, media-analysis service, subtitle
provider, or chat backend. The small browser script only makes the reference screens navigable.

Run it with any static file server:

```bash
python3 -m http.server 8000 --directory web
```

- Open `http://localhost:8000/` for playback confirmation.
- Open `http://localhost:8000/?screen=player` for the preparation/player structure.
- Add `&companion=Name` to preview a host-provided companion display name.

Hosts should preserve the visible state boundaries while replacing the browser-only preview
behavior with their own playback, session, chat, action, and risk adapters.
