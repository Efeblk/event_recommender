#!/usr/bin/env python3
"""Bounded, local GLiNER2.5 extraction benchmark for recommendation input.

Input may be a JSON document with a top-level ``conversations`` array, a JSON case
array, or JSONL. A case may contain ``turns``/``messages``; simple records use
``text``, ``message``, or ``input``. Expected labels and all other fields are
deliberately ignored. Output is one JSON object per extracted message. Model
output is a proposal and is never treated as truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import threading
import time
from pathlib import Path
from typing import Any, Iterable, TextIO


MODEL_ID = "fastino/gliner2.5-multi-v1"
MODEL_REVISION = "2ca71aafb3446d9014e1c55c7ff51c9bc7209c47"
SCHEMA_VERSION = "biplan-input-spans-v1"
MAX_MESSAGES_HARD = 60
EXTRACTION_THRESHOLD = 0.30

# This model-facing schema is immutable for an invocation and is constructed
# before input is read. Descriptions ask for complete expressions so a number or
# isolated adjective is not substituted for the clause that gives it meaning.
ENTITY_SCHEMA: dict[str, str] = {
    "amount": "A complete numeric or monetary amount including its currency or unit when written",
    "budget_expression": "The complete clause that states a spending budget, price ceiling, or price preference; include the amount and scope rather than returning only the number",
    "budget_basis": "The complete phrase saying whether a price or budget applies per person, per ticket, to the whole group, or in total",
    "budget_limit": "The complete phrase expressing a maximum, minimum, approximate, or target budget together with its amount",
    "date_expression": "A complete date, day, relative-date, date-range, or scheduling expression",
    "time_expression": "A complete clock-time, time-of-day, duration, or time-range expression",
    "party_expression": "The complete phrase describing attendee count, group composition, companions, or who will attend",
    "district": "A named Istanbul district, neighborhood, or explicitly requested geographic area",
    "category": "An event, performance, activity, genre, or venue category requested or rejected by the user",
    "semantic_preference": "A complete clause describing desired or undesired qualities, mood, style, experience, or suitability",
    "requirement_modifier": "The complete qualifier that changes a requirement's force or certainty, such as mandatory, preferred, optional, approximate, or excluded",
    "correction_expression": "The complete clause that corrects, replaces, negates, or resets an earlier request constraint",
}

RELATION_SCHEMA: dict[str, str] = {
    "modifier_of": "A qualifier or requirement modifier applies to another extracted expression",
    "budget_basis_of": "A per-person, per-ticket, group, or total basis applies to a budget or amount",
    "alternative_to": "One extracted expression is offered as an alternative to another",
    "excludes": "One extracted expression explicitly rules out or negates another",
}


def schema_payload() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "entities": ENTITY_SCHEMA,
        "relations": RELATION_SCHEMA,
        "threshold": EXTRACTION_THRESHOLD,
        "semantics": "unverified_model_proposals",
    }


SCHEMA_HASH = hashlib.sha256(
    json.dumps(schema_payload(), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()


class MemorySampler:
    def __init__(self, process: Any, interval_seconds: float = 0.05) -> None:
        self.process = process
        self.interval_seconds = interval_seconds
        self.peak_rss_bytes = process.memory_info().rss
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._sample, daemon=True)

    def _sample(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self.peak_rss_bytes = max(self.peak_rss_bytes, self.process.memory_info().rss)

    def __enter__(self) -> "MemorySampler":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)
        self.peak_rss_bytes = max(self.peak_rss_bytes, self.process.memory_info().rss)


def _iter_case(value: Any, line_number: int) -> Iterable[dict[str, Any]]:
    if isinstance(value, str):
        case_id = f"line-{line_number}"
        children: list[Any] = [value]
    elif isinstance(value, dict):
        case_id = str(
            value.get(
                "id",
                value.get("conversationId", value.get("case_id", f"line-{line_number}")),
            )
        )
        nested = value.get("turns", value.get("messages"))
        children = nested if isinstance(nested, list) else [value]
    else:
        raise ValueError(f"line {line_number}: expected a JSON string or object")

    for turn_index, child in enumerate(children):
        if isinstance(child, str):
            text = child
            message_id = f"{case_id}-turn-{turn_index}"
        elif isinstance(child, dict):
            # Read only identity and source text. In particular, never access an
            # expected/output/labels member from a benchmark case.
            text_value = child.get("text", child.get("message", child.get("input")))
            if not isinstance(text_value, str):
                raise ValueError(
                    f"line {line_number}, turn {turn_index}: missing string text/message/input"
                )
            text = text_value
            message_id = str(
                child.get("id", child.get("turnId", child.get("message_id", f"{case_id}-turn-{turn_index}")))
            )
        else:
            raise ValueError(f"line {line_number}, turn {turn_index}: expected a string or object")
        yield {
            "conversationId": case_id,
            "turnId": message_id,
            "turnIndex": turn_index,
            "sourceLine": line_number,
            "message": text,
        }


def iter_messages(stream: TextIO, maximum: int, skip: int = 0) -> Iterable[dict[str, Any]]:
    content = stream.read()
    if not content.strip():
        return
    values: list[tuple[int, Any]] = []
    try:
        document = json.loads(content)
    except json.JSONDecodeError:
        for line_number, line in enumerate(content.splitlines(), 1):
            if line.strip():
                values.append((line_number, json.loads(line)))
    else:
        if isinstance(document, dict) and isinstance(document.get("conversations"), list):
            values.extend((index + 1, case) for index, case in enumerate(document["conversations"]))
        elif isinstance(document, list):
            values.extend((index + 1, case) for index, case in enumerate(document))
        else:
            values.append((1, document))

    seen = 0
    emitted = 0
    for line_number, value in values:
        for item in _iter_case(value, line_number):
            if seen < skip:
                seen += 1
                continue
            if emitted >= maximum:
                return
            seen += 1
            emitted += 1
            yield item


def flatten_spans(raw_result: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    spans: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    entities = raw_result.get("entities", {})
    if not isinstance(entities, dict):
        return spans, [{"path": "$.entities", "error": "entities_not_an_object"}]
    for entity_type, mentions in entities.items():
        if not isinstance(mentions, list):
            mentions = [mentions]
        for index, mention in enumerate(mentions):
            if isinstance(mention, dict):
                span = {
                    "message": "current",
                    "start": mention.get("start"),
                    "end": mention.get("end"),
                    "text": mention.get("text"),
                    "type": entity_type,
                    "score": mention.get("confidence"),
                }
                spans.append(span)
                if span["start"] is None or span["end"] is None:
                    errors.append(
                        {"path": f"$.entities.{entity_type}[{index}]", "error": "span_offsets_missing"}
                    )
            else:
                spans.append(
                    {"message": "current", "start": None, "end": None, "text": mention, "type": entity_type, "score": None}
                )
                errors.append(
                    {"path": f"$.entities.{entity_type}[{index}]", "error": "unstructured_entity_span"}
                )
    return spans, errors


def _relation_endpoint(endpoint: Any) -> dict[str, Any]:
    if not isinstance(endpoint, dict):
        return {"message": "current", "start": None, "end": None, "text": endpoint, "type": None}
    return {
        "message": "current",
        "start": endpoint.get("start"),
        "end": endpoint.get("end"),
        "text": endpoint.get("text"),
        "type": endpoint.get("type"),
    }


def flatten_relations(raw_result: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    relations: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    groups = raw_result.get("relation_extraction", {})
    if not isinstance(groups, dict):
        return relations, [{"path": "$.relation_extraction", "error": "relations_not_an_object"}]
    for relation_type, proposals in groups.items():
        if not isinstance(proposals, list):
            proposals = [proposals]
        for index, proposal in enumerate(proposals):
            if not isinstance(proposal, dict):
                errors.append(
                    {"path": f"$.relation_extraction.{relation_type}[{index}]", "error": "unstructured_relation"}
                )
                continue
            head = _relation_endpoint(proposal.get("head"))
            tail = _relation_endpoint(proposal.get("tail"))
            relations.append(
                {
                    "type": relation_type,
                    "score": proposal.get("confidence"),
                    "head": head,
                    "tail": tail,
                }
            )
            if head["start"] is None or head["end"] is None or tail["start"] is None or tail["end"] is None:
                errors.append(
                    {"path": f"$.relation_extraction.{relation_type}[{index}]", "error": "relation_endpoint_offsets_missing"}
                )
    return relations, errors


def inspect_spans(value: Any, source: str, path: str = "$") -> tuple[int, list[dict[str, Any]]]:
    checked = 0
    issues: list[dict[str, Any]] = []
    if isinstance(value, dict):
        has_span_member = any(key in value for key in ("start", "end"))
        if has_span_member:
            checked += 1
            start, end, extracted = value.get("start"), value.get("end"), value.get("text")
            issue: str | None = None
            actual: str | None = None
            if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool):
                issue = "non_integer_or_incomplete_span"
            elif start < 0 or end < start or end > len(source):
                issue = "span_out_of_bounds"
            else:
                actual = source[start:end]
                if not isinstance(extracted, str):
                    issue = "span_text_missing_or_non_string"
                elif actual != extracted:
                    issue = "span_text_roundtrip_mismatch"
            if issue:
                issues.append(
                    {
                        "path": path,
                        "error": issue,
                        "start": start,
                        "end": end,
                        "reported_text": extracted,
                        "source_slice": actual,
                    }
                )
        for key, child in value.items():
            child_checked, child_issues = inspect_spans(child, source, f"{path}.{key}")
            checked += child_checked
            issues.extend(child_issues)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_checked, child_issues = inspect_spans(child, source, f"{path}[{index}]")
            checked += child_checked
            issues.extend(child_issues)
    return checked, issues


def write_json_line(stream: TextIO, value: dict[str, Any]) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="UTF-8 JSONL input path, or - for stdin")
    parser.add_argument("--output", default="-", help="UTF-8 JSONL output path, or - for stdout")
    parser.add_argument("--provenance", help="Optional JSON provenance/summary output path")
    parser.add_argument("--runtime-dir", required=True, help="Ignored directory for the pinned model snapshot")
    parser.add_argument("--max-messages", type=int, default=MAX_MESSAGES_HARD)
    parser.add_argument("--skip-messages", type=int, default=0, help="Skip this many messages in input order")
    parser.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--offline", action="store_true", help="Require the already downloaded local snapshot")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.max_messages <= MAX_MESSAGES_HARD:
        raise ValueError(f"--max-messages must be between 1 and {MAX_MESSAGES_HARD}")
    if args.skip_messages < 0:
        raise ValueError("--skip-messages cannot be negative")
    if args.threads < 1:
        raise ValueError("--threads must be positive")

    runtime_dir = Path(args.runtime_dir).resolve()
    model_dir = runtime_dir / "model" / MODEL_REVISION
    runtime_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(runtime_dir / "hf-home")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    if args.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

    # Heavy imports happen after local cache and CPU limits are fixed.
    import psutil
    import torch
    from gliner2 import AutoExtractor, __version__ as gliner2_version
    from huggingface_hub import snapshot_download

    torch.set_num_threads(args.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    process = psutil.Process()
    rss_before_load = process.memory_info().rss
    load_started = time.perf_counter()
    with MemorySampler(process) as load_memory:
        snapshot_path = snapshot_download(
            repo_id=MODEL_ID,
            revision=MODEL_REVISION,
            local_dir=model_dir,
            local_files_only=args.offline,
        )
        model = AutoExtractor.from_pretrained(snapshot_path, map_location="cpu")
        model.eval()
        schema = (
            model.create_schema()
            .entities(dict(ENTITY_SCHEMA), threshold=EXTRACTION_THRESHOLD)
            .relations(dict(RELATION_SCHEMA), threshold=EXTRACTION_THRESHOLD)
        )
    load_seconds = time.perf_counter() - load_started
    rss_after_load = process.memory_info().rss

    input_stream = sys.stdin if args.input == "-" else open(args.input, "r", encoding="utf-8", newline="")
    output_stream = sys.stdout if args.output == "-" else open(args.output, "w", encoding="utf-8", newline="\n")
    records = 0
    inference_seconds: list[float] = []
    run_started = time.perf_counter()
    try:
        for item in iter_messages(input_stream, args.max_messages, args.skip_messages):
            rss_before = process.memory_info().rss
            inference_started = time.perf_counter()
            with MemorySampler(process) as inference_memory, torch.inference_mode():
                raw_result = model.extract(
                    item["message"],
                    schema,
                    threshold=EXTRACTION_THRESHOLD,
                    include_spans=True,
                    include_confidence=True,
                )
            elapsed = time.perf_counter() - inference_started
            inference_seconds.append(elapsed)
            checked, issues = inspect_spans(raw_result, item["message"])
            spans, span_shape_errors = flatten_spans(raw_result)
            relations, relation_shape_errors = flatten_relations(raw_result)
            validation_errors = issues + span_shape_errors + relation_shape_errors
            write_json_line(
                output_stream,
                {
                    **item,
                    "spans": spans,
                    "relations": relations,
                    "timing": {
                        "loadSeconds": load_seconds,
                        "inferenceSeconds": elapsed,
                        "temperature": "cold" if records == 0 else "warm",
                    },
                    "validationErrors": validation_errors,
                    "schema_version": SCHEMA_VERSION,
                    "schema_sha256": SCHEMA_HASH,
                    "proposal_semantics": "unverified_model_proposals_not_truth",
                    "raw_result": raw_result,
                    "span_validation": {
                        "offset_unit": "unicode_code_points_half_open",
                        "checked": checked,
                        "valid": not validation_errors,
                        "issues": issues,
                    },
                    "memory": {
                        "process_rss_before_bytes": rss_before,
                        "process_rss_after_bytes": process.memory_info().rss,
                        "process_peak_sampled_rss_bytes": inference_memory.peak_rss_bytes,
                        "sampling_interval_seconds": inference_memory.interval_seconds,
                    },
                },
            )
            records += 1
    finally:
        if input_stream is not sys.stdin:
            input_stream.close()
        if output_stream is not sys.stdout:
            output_stream.close()

    provenance = {
        "type": "gliner_run_provenance",
        "model": {
            "id": MODEL_ID,
            "revision": MODEL_REVISION,
            "local_snapshot": str(Path(snapshot_path).resolve()),
            "architecture": getattr(model.config, "architecture", None),
        },
        "library": {"gliner2": gliner2_version, "torch": torch.__version__, "python": platform.python_version()},
        "runtime": {
            "device": "cpu",
            "cpu": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
            "torch_threads": torch.get_num_threads(),
            "torch_interop_threads": torch.get_num_interop_threads(),
            "platform": platform.platform(),
        },
        "schema": schema_payload(),
        "schema_sha256": SCHEMA_HASH,
        "schema_frozen_before_input": True,
        "extraction_threshold": EXTRACTION_THRESHOLD,
        "benchmark_expected_labels_read": False,
        "multilingual_accuracy": "unknown_not_calibrated",
        "proposal_semantics": "unverified_model_proposals_not_truth",
        "counts": {"messages": records},
        "input_selection": {"skip_messages": args.skip_messages, "max_messages": args.max_messages},
        "timing": {
            "load_seconds": load_seconds,
            "first_inference_cold_seconds": inference_seconds[0] if inference_seconds else None,
            "warm_inference_seconds": inference_seconds[1:],
            "total_seconds": time.perf_counter() - run_started + load_seconds,
        },
        "memory": {
            "process_rss_before_load_bytes": rss_before_load,
            "process_rss_after_load_bytes": rss_after_load,
            "process_peak_sampled_load_rss_bytes": load_memory.peak_rss_bytes,
            "sampling_interval_seconds": load_memory.interval_seconds,
        },
    }
    if args.provenance:
        Path(args.provenance).write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
    else:
        print(json.dumps(provenance, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"type": "gliner_error", "error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        raise
