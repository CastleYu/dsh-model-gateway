#!/usr/bin/env python3
"""Minimal OpenAI-compatible gateway skeleton.

Copy this file next to your own upstream code, replace `complete()` with the
real call, and point a model-gateway config at it.  Standard library only, so
it runs anywhere Python 3.10+ is available.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8099"))
MODEL = os.environ.get("GATEWAY_MODEL", "my-model")


def complete(payload: dict) -> tuple[str, str]:
    """Return (reasoning, text). Replace this with your upstream call."""
    prompt = ""
    for message in reversed(payload.get("messages") or []):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                prompt = content
            elif isinstance(content, list):
                prompt = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            break
    return "The skeleton gateway received the request.", f"echo: {prompt}"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", file=sys.stderr, flush=True)

    def send_json(self, status: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        elif self.path in ("/v1/models", "/models"):
            self.send_json(200, {"data": [{"id": MODEL, "name": MODEL}]})
        else:
            self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as error:  # noqa: BLE001
            self.send_json(400, {"error": {"message": str(error)}})
            return

        reasoning, text = complete(payload)
        if not payload.get("stream"):
            self.send_json(200, {
                "id": "chatcmpl-local",
                "model": payload.get("model", MODEL),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def event(value: dict) -> None:
            self.wfile.write(f"data: {json.dumps(value, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        event({"choices": [{"index": 0, "delta": {"reasoning_content": reasoning}}]})
        event({"choices": [{"index": 0, "delta": {"content": text}}]})
        event({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        event({"choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"gateway skeleton listening on http://127.0.0.1:{PORT}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
