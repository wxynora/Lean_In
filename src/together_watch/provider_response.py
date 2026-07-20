from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping


class StructuredResponseError(ValueError):
    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code
        self.usage: Mapping[str, Any] = {}


@dataclass(frozen=True, slots=True)
class StructuredProviderResult:
    payload: Mapping[str, Any]
    usage: Mapping[str, Any]


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(float(value)))
    except (TypeError, ValueError):
        return 0


def _non_negative_float(value: Any) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return 0.0


def normalize_provider_usage(response: Mapping[str, Any]) -> dict[str, Any]:
    raw = response.get("usage")
    usage = raw if isinstance(raw, Mapping) else {}
    cost_reported = "cost" in usage or "cost_usd" in usage
    cost_value = usage.get("cost") if "cost" in usage else usage.get("cost_usd")
    input_tokens = _non_negative_int(usage.get("prompt_tokens") or usage.get("input_tokens"))
    output_tokens = _non_negative_int(
        usage.get("completion_tokens") or usage.get("output_tokens")
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": _non_negative_int(usage.get("total_tokens"))
        or input_tokens + output_tokens,
        "cost_usd": _non_negative_float(cost_value),
        "provider_called": True,
        "cost_reported": cost_reported,
        "model": str(response.get("model") or "").strip(),
    }


def _without_trailing_commas(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            index += 1
            continue
        if char == ",":
            next_index = index + 1
            while next_index < len(text) and text[next_index].isspace():
                next_index += 1
            if next_index < len(text) and text[next_index] in "}]":
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


def _balanced_objects(text: str) -> tuple[list[str], bool]:
    candidates: list[str] = []
    saw_incomplete = False
    for start, char in enumerate(text):
        if char != "{":
            continue
        stack: list[str] = []
        in_string = False
        escaped = False
        for index in range(start, len(text)):
            current = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    in_string = False
                continue
            if current == '"':
                in_string = True
                continue
            if current in "{[":
                stack.append(current)
                continue
            if current not in "}]":
                continue
            expected = "{" if current == "}" else "["
            if not stack or stack[-1] != expected:
                break
            stack.pop()
            if not stack:
                candidates.append(text[start : index + 1])
                break
        else:
            saw_incomplete = True
    return candidates, saw_incomplete


def _content_candidates(content: Any) -> tuple[list[dict[str, Any]], list[str]]:
    objects: list[dict[str, Any]] = []
    texts: list[str] = []
    if isinstance(content, Mapping):
        for key in ("parsed", "json"):
            value = content.get(key)
            if isinstance(value, Mapping):
                objects.append(dict(value))
        if isinstance(content.get("text"), str):
            texts.append(str(content["text"]))
        elif isinstance(content.get("content"), (str, list, Mapping)):
            nested_objects, nested_texts = _content_candidates(content["content"])
            objects.extend(nested_objects)
            texts.extend(nested_texts)
        elif not objects:
            objects.append(dict(content))
        return objects, texts
    if isinstance(content, list):
        combined: list[str] = []
        for item in content:
            nested_objects, nested_texts = _content_candidates(item)
            objects.extend(nested_objects)
            texts.extend(nested_texts)
            combined.extend(nested_texts)
        if len(combined) > 1:
            texts.append("".join(combined))
        return objects, texts
    if isinstance(content, str):
        texts.append(content)
    return objects, texts


def _parse_json_object(text: str) -> dict[str, Any] | None:
    candidate = text.strip().lstrip("\ufeff")
    if not candidate:
        return None
    for attempt in (candidate, _without_trailing_commas(candidate)):
        try:
            parsed = json.loads(attempt, strict=False)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, str) and parsed != attempt:
            nested = _parse_json_object(parsed)
            if nested is not None:
                return nested
        if isinstance(parsed, dict):
            return parsed
    return None


def extract_structured_object(
    content: Any,
    *,
    required_fields: Iterable[str] = (),
) -> dict[str, Any]:
    required = {str(field) for field in required_fields if str(field)}
    objects, texts = _content_candidates(content)
    parsed_objects = list(objects)
    saw_object_marker = False
    saw_incomplete = False
    for text in texts:
        parsed = _parse_json_object(text)
        if parsed is not None:
            parsed_objects.append(parsed)
            continue
        candidates, incomplete = _balanced_objects(text)
        saw_object_marker = saw_object_marker or "{" in text
        saw_incomplete = saw_incomplete or incomplete
        for candidate in candidates:
            parsed = _parse_json_object(candidate)
            if parsed is not None:
                parsed_objects.append(parsed)
    eligible = [item for item in parsed_objects if not required or required.intersection(item)]
    if eligible:
        return max(
            eligible,
            key=lambda item: (len(required.intersection(item)), len(item)),
        )
    if saw_incomplete:
        raise StructuredResponseError("structured JSON is incomplete", code="json_incomplete")
    if saw_object_marker:
        raise StructuredResponseError("structured JSON cannot be parsed", code="json_invalid")
    if not objects and not any(text.strip() for text in texts):
        raise StructuredResponseError("provider returned empty content", code="empty_content")
    raise StructuredResponseError(
        "provider returned no usable structured object",
        code="structured_result_missing",
    )


def parse_openai_compatible_response(
    response: Mapping[str, Any],
    *,
    required_fields: Iterable[str] = (),
) -> StructuredProviderResult:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
        raise StructuredResponseError("provider response has no message choice", code="message_missing")
    message = choices[0].get("message")
    if not isinstance(message, Mapping):
        raise StructuredResponseError("provider response has no message object", code="message_missing")
    usage = normalize_provider_usage(response)
    try:
        payload = extract_structured_object(message, required_fields=required_fields)
    except StructuredResponseError as exc:
        exc.usage = usage
        raise
    return StructuredProviderResult(payload=payload, usage=usage)
