# Current Work

## LEAN-IN-TICKET-CAPTURES-20260722

- Mode: construction
- Status: complete
- Objective: add viewing-level multi-image ticket captures to the open-source reference backend and Web client contract, while preserving the existing automatic-frame selection path. Captures must survive session cleanup, save progress, completion, part changes, and clearing the current ticket back.
- Evidence scope:
  - the currently modified `README.md`, `docs/{architecture,protocol,CURRENT_WORK}.md`, and `schema/watch-v1.schema.json`;
  - `src/together_watch/{models,viewing,providers,__init__}.py`, `examples/provider_config.example.json`, and focused Python tests;
  - the currently modified `web` API, ticket, host, UI, asset, README, and focused Web tests.
- Write scope: exactly the evidence files above, plus a focused capture test only if the existing viewing test cannot express the route/state contract.
- Excluded: private gateway specifics, Android/native code, companion names, Stay with Du, deployment, and any implicit image count/byte/retention limit.
- Acceptance:
  - one viewing stores multiple JPEG captures with session/media/epoch provenance;
  - list and image retrieval remain available after save, complete, cleanup, and part changes;
  - selecting by `capture_id` works without an active session and updates an existing ticket;
  - clearing the ticket back preserves the capture collection;
  - the Web reference client exposes the upload/list/select contract without private-host assumptions;
  - focused Python/Web tests and scoped diff checks pass;
  - all completed open-source changes in the declared status set are committed and pushed to `origin/main`.
- Optional-provider requirement: TMDB identity resolution is an explicitly optional enhancement for a user-triggered subtitle retry after ordinary subtitle lookup fails. Missing TMDB configuration must remain `not_configured` and must not block SubDL title lookup, local subtitles, or playback.
- Verification: `PYTHONPATH=src python3 -m unittest discover -s tests` passed 67 tests; `node --test web/tests/*.test.js` passed 29 tests; `git diff --check` passed before final staging. The optional TMDB setting defaults off and stores only the server-side environment-variable name.

## LEAN-IN-WATCH-RESUME-20260722

- Mode: construction
- Status: complete
- Objective: distinguish technical cleanup, save progress, and completed viewing exits. Saving progress must preserve the viewing identity, playback position, completed analysis cache, and any optional ticket-back image so the session can be resumed from Recent Watch without creating a ticket. The back image may be an explicitly selected analysis frame or a browser-local upload. Completing a viewing creates or reuses one stable ticket.
- Retention rule: saved progress retains its completed plot analysis as resumable state. It is separate from completed-viewing retention. Only after `complete` does the finished work's plot analysis enter a configurable TTL whose reference default is 24 hours; the ticket survives that expiry.
- Evidence scope:
  - `src/together_watch/{models,viewing,__init__}.py`
  - `schema/watch-v1.schema.json`
  - focused protocol, architecture, README, and Python tests for viewing/tickets
- Write scope: the backend/model/schema/document/test files above and `docs/CURRENT_WORK.md`. Frontend files may only be restored to their exact pre-task state to remove this task's partial Web implementation.
- Excluded: new frontend implementation, native Android, private gateway, unrelated open-source modules, deployment, commit, and push.
- Acceptance:
  - technical cleanup creates neither resume progress nor ticket;
  - save progress records a resumable playback point and creates no ticket;
  - resume reuses the same `viewing_id` and exposes retained-analysis metadata;
  - complete clears resumable progress and returns one idempotent ticket;
  - save retains resumable plot analysis, while complete starts a separate 24-hour default plot-analysis TTL without extending raw sample retention;
  - the backend contract exposes enough data and routes for a frontend to offer save/complete, Recent Watch resume, optional selected-frame persistence, and optional client-local image upload;
  - focused Python tests and diff check pass.
- Completion note: the reference viewing/ticket backend, schema, docs, and tests are complete. A later explicit instruction authorized the browser reference implementation and push; that work is tracked by `LEAN-IN-TICKET-CAPTURES-20260722` and supersedes this task's earlier frontend/commit exclusion.
