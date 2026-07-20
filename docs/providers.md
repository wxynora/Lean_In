# Provider and Prompt Integration

Lean In ships provider-neutral prompt bundles and adapter contracts. It does not require a
specific HTTP framework, model SDK, search API, database, or queue. A host owns transport and
persistence while reusing the same evidence rules and structured outputs.

## Included Prompt Resources

The installed Python package includes these canonical resources:

| Resource | Purpose |
| --- | --- |
| `prompt_templates/analysis_system.txt` | Evidence rules for identify, timeline prepass, rolling plot, and risks. |
| `prompt_templates/analysis_background_known.txt` | Requires an empty visible background for a known work. |
| `prompt_templates/analysis_background_needed.txt` | Permits only background established by the watched boundary. |
| `prompt_templates/analysis_user.txt` | Adds the task purpose and host-built input context. |
| `schemas/analysis_result.schema.json` | Strict plot, story-state, timeline, and risk output. |
| `prompt_templates/knowledge_system.txt` | Spoiler-controlled pre-play knowledge-card rules. |
| `prompt_templates/knowledge_user.txt` | Adds target identity and host-supplied search sources. |
| `schemas/knowledge_card.schema.json` | Strict identity, setting, character, term, source, and limitation output. |
| `prompt_templates/companion_context_zh.txt` | Placeholder Chinese dynamic-system template for the companion reply turn. |

Applications may import the ready-to-send bundles:

```python
from together_watch import build_analysis_prompt, build_knowledge_prompt

analysis = build_analysis_prompt(
    purpose="rolling",
    knowledge_mode="needs_summary",
    output_language="Chinese",
    context={
        "media": {"id": "movie:1", "duration_ms": 7_200_000},
        "range": {"start_ms": 120_000, "end_ms": 260_000},
        "previous_story_so_far": {},
        "previous_story_state": {},
        "samples": [],
    },
)

knowledge = build_knowledge_prompt(
    output_language="Chinese",
    target={"title": "Example", "original_title": "Original Example", "year": 2025},
    sources=[
        {
            "source_id": "source-1",
            "title": "Official introduction",
            "url": "https://example.invalid/work",
            "snippet": "A spoiler-free public introduction.",
            "scope": "target_work",
        }
    ],
)
```

Each result is a `PromptBundle` with `system_prompt`, `user_prompt`, `response_schema`, and a stable
`prompt_id`. The host attaches authorized media parts after the analysis user text. Prompt files are
ordinary package data, so a downstream project can copy, review, translate, or replace them.

The Python builders are optional conveniences. A non-Python backend can copy the text templates and
JSON schemas directly, replace the documented placeholders, and send the same bundle through its
own model SDK. Lean In does not require importing this package in the production service.

## Host Integration Sequence

1. Identify the selected work and choose `known` or `needs_summary` before playback.
2. If a visible knowledge card is needed, run the configured external or model-native search.
3. Pass only the selected target and returned source rows to `build_knowledge_prompt`, then show the
   structured card to the viewer for confirmation.
4. For each authorized media range, pass audio, frames, subtitle cues, prior confirmed story state,
   and the optional confirmed card to `build_analysis_prompt`.
5. Store the returned plot and risk records in the host's own persistence layer and expose them
   through the host's own frontend/backend contract.

These steps describe data flow, not required endpoints, tables, queues, or UI components.

Rolling calls must treat `story_so_far.summary` and `story_state.events` as compact rewritten state,
not append-only history. Keep active goals, unresolved matters, and causal nodes still needed for the
current plot; merge resolved older process into concise background. This prevents cumulative prompts
and responses from growing with every batch while preserving continuity.

## Model Transport

`StructuredModelProvider` is the low-level model boundary. A host can map a `PromptBundle` to:

- Gemini native `system_instruction`, multimodal `contents`, JSON response MIME, and response schema;
- an OpenAI-compatible messages endpoint with image/audio parts and structured JSON output;
- another multimodal model that can honor the same evidence boundary and schema.

The core does not inject viewer names, companion names, relationship prompts, chat archives, local
paths, cookies, or credentials. Product-specific visible chat context belongs in
`ContextHostAdapter`, after media analysis has completed.

For that final host-owned step, `build_companion_context_prompt()` renders a `ContextEnvelope` into
the included Chinese placeholder template. Its defaults are `{assistant}`, `{viewer}`, and `{work}`;
the integrating application replaces them with its own display names. The result is a dynamic system
message for the real chat turn, not a personality prompt and not a pre-generated reply. It keeps
current and reply-arrival plot visible while isolating later scheduled-future plot to hidden timed
danmaku instructions.

If a contact sheet is available, attach it as a separate user content block immediately before the
real viewer message, using `COMPANION_VISUAL_USER_LABEL` (`【剧情画面】`) followed by the image part.
Do not place the image in the system text, and do not replace the viewer's real message with it.

`ModelProviderConfig` records the public provider name, model name, transport, optional endpoint,
API-key environment-variable name, and host-owned options. It never reads the secret itself.

Schema output remains a request-side preference, not a brittle parsing assumption. For
OpenAI-compatible responses, `parse_openai_compatible_response()` accepts `message.parsed`, JSON or
text content blocks, fenced JSON, surrounding prose, and deterministic trailing commas. It rejects
truncated objects and payloads missing host-supplied required fields. On failure, the exception keeps
normalized usage returned by the provider so a billed call can be included in session cost without
committing invalid plot or risk data. Hosts should log their own full response envelope with session,
job, purpose, and media-range identifiers; never log attached audio, frames, credentials, or cookies.

## Analysis Input Contract

The host builds `context` from the current job and confirmed state. Recommended fields are:

```json
{
  "purpose": "rolling",
  "media": {
    "id": "movie:1",
    "source": "local_file",
    "title": "Example",
    "part_title": "",
    "duration_ms": 7200000,
    "content_start_ms": 0,
    "content_end_ms": 7080000
  },
  "range": { "start_ms": 120000, "end_ms": 260000 },
  "previous_familiarity": "partial",
  "previous_identity": "",
  "previous_story_so_far": {},
  "previous_story_state": {},
  "work_knowledge_card": null,
  "samples": [
    { "at_ms": 140000, "kind": "image", "subtitle": "" },
    { "start_ms": 120000, "end_ms": 260000, "kind": "audio" }
  ]
}
```

Only attach media authorized by the active sample plan. The model must not receive the complete
local file, a future range beyond the current analysis boundary, or unrelated chat history.

## Knowledge Search Modes

Knowledge preparation is explicitly configurable through `KnowledgeSearchConfig`:

| Mode | Host behavior |
| --- | --- |
| `external` | Call `KnowledgeSearchProvider`, then pass normalized sources to the knowledge prompt. |
| `model_native` | Enable the model vendor's native web-search/grounding tool for this request. |
| `disabled` | Return a visible not-configured state and allow the user to skip the optional card. |

The built-in query template is:

```text
《{title}》剧情简介 主要人物 人物关系 世界观
```

`title_preference` controls whether `{title}` uses `original_title` or the display title. Season,
episode, or part labels can be appended by `build_knowledge_search_query`. A host can replace the
entire query template and pass provider-specific options without changing the core.

External search rows should be normalized to stable IDs, titles, URLs, snippets, and a scope of
`target_work` or `continuity_reference`. Result count is a visible provider option; the example
configuration requests three results, but the core does not silently truncate rows passed to
`build_knowledge_prompt`.

When external search is not configured, a Gemini adapter may implement `model_native` with Google
Search grounding. This is an explicit host configuration, not an automatic private fallback.

## Configuration Example

[`examples/provider_config.example.json`](../examples/provider_config.example.json) shows two model
roles and an external-search setup. To use native Gemini search instead, change
`knowledge_search.mode` to `model_native` and omit the external endpoint and key environment name.

The example contains no credentials. Resolve every `api_key_env` from the host process environment
or secret manager. Browser code must never receive model or search credentials.

## Subtitle Providers

Subtitle lookup remains an independent `SubtitleProvider`. A host may use a local SRT/VTT upload,
SubDL, OpenSubtitles, ChineseSubFinder, or another provider. Normalize all results to timed cues and
bind them to media revision, edition, selected track, language, and signed offset. A missing provider
or no result is an explicit state, not a reason to fabricate subtitle evidence.

Network subtitle lookup should use its own short policy instead of inheriting long media-acquisition
timeouts. `SubtitleLookupPolicy` defaults to a 15-second request timeout, a 45-second total lookup
budget, and one automatic attempt. `deduplicate_subtitle_candidates()` preserves provider order while
removing repeated download URLs; it does not impose a hidden candidate-count limit. After a terminal
failure, let the preparation UI offer an explicit retry. Log search/download stage durations and
status, but never subtitle bodies, cookies, or credentials.
