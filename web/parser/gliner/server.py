#!/usr/bin/env python3
"""Local GLiNER2 span proposer for the request parser.

POST /extract {"text": "..."} -> {"spans": [{"label", "text", "start", "end", "score"}]}
Spans are proposals only: the parser lets Jev judge every one of them.
Offsets are code points; the parser re-checks them against its own string.
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import torch  # noqa: E402
from gliner2 import AutoExtractor  # noqa: E402

LABELS = {
    "topic": "A subject, theme, genre, artist or musical style the event should be about, such as 2000s Turkish pop, "
    "photography, Ottoman history or jazz. Not an event format such as concert or workshop.",
    "condition": "A requirement about the venue, seating, food, accessibility, admission, service or guarantees, such as "
    "a hearing loop, a vegan food option, valet parking or front-row seats.",
}
THRESHOLD = 0.3

model = AutoExtractor.from_pretrained(os.environ["GLINER_MODEL_DIR"], map_location="cpu")
model.eval()
torch.set_num_threads(int(os.environ.get("GLINER_THREADS", "4")))
schema = model.create_schema().entities(LABELS, threshold=THRESHOLD)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/extract":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        text = body.get("text")
        if not isinstance(text, str) or not text or len(text) > 2000:
            self.send_error(400)
            return
        with torch.inference_mode():
            raw = model.extract(text, schema, threshold=THRESHOLD, include_spans=True, include_confidence=True)
        spans = [
            {"label": label, "text": m["text"], "start": m["start"], "end": m["end"], "score": m["confidence"]}
            for label, mentions in raw.get("entities", {}).items()
            for m in mentions
            if isinstance(m, dict) and isinstance(m.get("start"), int)
        ]
        payload = json.dumps({"spans": spans}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_: object) -> None:
        pass


if __name__ == "__main__":
    port = int(os.environ.get("GLINER_PORT", "8765"))
    print(f"gliner listening on 127.0.0.1:{port}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
