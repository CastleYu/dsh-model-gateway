#!/usr/bin/env python3
"""Local OpenAI-compatible gateway for OpenCode Go.

This is the worked example for the DSH model-gateway framework.  It is a
normal standalone program: the framework starts it, watches /health, restarts
it on crashes, and points a DSH model route at /v1/chat/completions.

Two modes:

  mock  no network, deterministic SSE/JSON.  Used for framework verification
        when no OpenCode Go credential is available.
  live  forwards Chat Completions to
        https://opencode.ai/inference/go/openai/v1/chat/completions with the
        x-opencode-session header the Go service requires.

Only the Python standard library is used, so the framework does not need to
install anything into the user's Python environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import request as urlrequest

VERSION = "0.1.0"
DEFAULT_UPSTREAM = "https://opencode.ai/inference/go/openai/v1"
DEFAULT_PORT = 47180
DEFAULT_MODELS = [
    {"id": "deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash", "context_window": 262144, "max_tokens": 32768},
    {"id": "glm-5.3-flash", "name": "GLM-5.3 Flash", "context_window": 131072, "max_tokens": 16384},
    {"id": "kimi-k3", "name": "Kimi K3", "context_window": 262144, "max_tokens": 32768},
]


def log(message: str) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    print(f"{stamp} {message}", file=sys.stderr, flush=True)


def join_chat_url(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def join_models_url(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return f"{base}/models"


def last_user_text(payload: dict) -> str:
    for message in reversed(payload.get("messages") or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
            return "\n".join(parts)
    return ""


class GatewayConfig:
    def __init__(self, args: argparse.Namespace) -> None:
        self.host = args.host
        self.port = args.port
        self.mode = args.mode
        self.upstream = args.upstream
        self.api_key_env = args.api_key_env
        self.models = DEFAULT_MODELS
        if args.models:
            ids = [item.strip() for item in args.models.split(",") if item.strip()]
            if ids:
                self.models = [
                    {
                        "id": item,
                        "name": item,
                        "context_window": 131072,
                        "max_tokens": 16384,
                    }
                    for item in ids
                ]
        self.session_id = f"ses_{uuid.uuid4().hex}"

    @property
    def api_key(self) -> str:
        return os.environ.get(self.api_key_env, "").strip()

    @property
    def effective_mode(self) -> str:
        if self.mode == "auto":
            return "live" if self.api_key else "mock"
        return self.mode


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"dsh-opencode-go-gateway/{VERSION}"

    @property
    def cfg(self) -> GatewayConfig:
        return self.server.gateway_config  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib name
        # The supervisor polls /health every few seconds; those access lines
        # would dominate the persisted diagnostic log without adding signal.
        message = fmt % args
        if '"GET /health ' in message:
            return
        log(f"{self.address_string()} {message}")

    def send_json(self, status: int, payload: dict, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("x-gateway-mode", self.cfg.effective_mode)
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def begin_sse(self, extra_headers: dict | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("x-gateway-mode", self.cfg.effective_mode)
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.close_connection = True

    def write_sse(self, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    def write_done(self) -> None:
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802 - stdlib name
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send_json(200, {
                "ok": True,
                "status": "ready",
                "version": VERSION,
                "mode": self.cfg.effective_mode,
                "upstream": self.cfg.upstream,
                "session": self.cfg.session_id,
                "models": [model["id"] for model in self.cfg.models],
                "pid": os.getpid(),
            })
            return
        if path in ("/v1/models", "/models"):
            self.send_json(200, {
                "object": "list",
                "data": [
                    {
                        "id": model["id"],
                        "object": "model",
                        "name": model["name"],
                        "context_window": model["context_window"],
                        "max_tokens": model["max_tokens"],
                    }
                    for model in self.cfg.models
                ],
            })
            return
        if path == "/":
            self.send_json(200, {
                "name": "dsh-opencode-go-gateway",
                "version": VERSION,
                "mode": self.cfg.effective_mode,
                "endpoints": ["/health", "/v1/models", "/v1/chat/completions"],
            })
            return
        self.send_json(404, {"error": {"type": "not_found", "message": f"no route for {path}"}})

    def do_POST(self) -> None:  # noqa: N802 - stdlib name
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self.send_json(404, {"error": {"type": "not_found", "message": f"no route for {path}"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
        except Exception as exc:  # noqa: BLE001 - report protocol errors to the caller
            self.send_json(400, {"error": {"type": "invalid_request", "message": str(exc)}})
            return

        model = payload.get("model", "unknown")
        stream = bool(payload.get("stream", False))
        log(f"chat model={model} stream={stream} messages={len(payload.get('messages') or [])} tools={len(payload.get('tools') or [])}")
        if self.cfg.effective_mode == "mock":
            self.mock_completion(payload, stream)
            return
        self.proxy_completion(payload, stream)

    def mock_completion(self, payload: dict, stream: bool) -> None:
        prompt = last_user_text(payload).strip().replace("\n", " ")
        if len(prompt) > 240:
            prompt = prompt[:240] + "…"
        model = payload.get("model", "unknown")
        reasoning = "The local mock gateway received the request and is answering deterministically."
        text = f"Mock OpenCode Go gateway is reachable. model={model}. You said: {prompt or '(empty prompt)'}"
        usage = {
            "prompt_tokens": max(1, len(prompt) // 4 + 16),
            "completion_tokens": max(1, len(text) // 4),
            "total_tokens": max(1, len(prompt) // 4 + 16) + max(1, len(text) // 4),
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 12},
        }

        tool_call = None
        if "TOOL_CALL" in prompt and payload.get("tools"):
            first = payload["tools"][0]
            function = first.get("function") if isinstance(first, dict) else None
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                tool_call = {
                    "id": f"call_{uuid.uuid4().hex[:24]}",
                    "type": "function",
                    "function": {"name": function["name"], "arguments": "{}"},
                }

        if not stream:
            message = {"role": "assistant", "content": text}
            if tool_call is not None:
                message["tool_calls"] = [tool_call]
                message["content"] = None
            self.send_json(200, {
                "id": f"chatcmpl_{uuid.uuid4().hex[:24]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": message,
                    "finish_reason": "tool_calls" if tool_call else "stop",
                }],
                "usage": usage,
            })
            return

        self.begin_sse()
        self.write_sse({"id": f"chatcmpl_{uuid.uuid4().hex[:24]}", "model": model, "choices": [{"index": 0, "delta": {"role": "assistant"}}]})
        self.write_sse({"id": "mock", "model": model, "choices": [{"index": 0, "delta": {"reasoning_content": reasoning}}]})
        for piece in (text[: max(1, len(text) // 2)], text[max(1, len(text) // 2):]):
            if piece:
                self.write_sse({"id": "mock", "model": model, "choices": [{"index": 0, "delta": {"content": piece}}]})
                time.sleep(0.01)
        if tool_call is not None:
            self.write_sse({
                "id": "mock",
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": tool_call["id"],
                            "type": "function",
                            "function": tool_call["function"],
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
            })
        else:
            self.write_sse({"id": "mock", "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self.write_sse({"id": "mock", "model": model, "choices": [], "usage": usage})
        self.write_done()
        log(f"mock stream complete model={model} bytes~{len(text)}")

    def proxy_completion(self, payload: dict, stream: bool) -> None:
        key = self.cfg.api_key
        if not key:
            self.send_json(503, {
                "error": {
                    "type": "missing_credential",
                    "message": f"{self.cfg.api_key_env} is not set; the gateway is in live mode but has no OpenCode Go key.",
                }
            })
            return
        session_id = self.headers.get("x-opencode-session") or self.cfg.session_id
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if stream else "application/json",
            "User-Agent": f"dsh-model-gateway-opencode-go/{VERSION}",
            "x-opencode-session": session_id,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        upstream = join_chat_url(self.cfg.upstream)
        request = urlrequest.Request(upstream, data=body, headers=headers, method="POST")
        started = time.time()
        try:
            response = urlrequest.urlopen(request, timeout=300)
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            log(f"upstream HTTP {exc.code} session={session_id} detail={detail[:500]}")
            try:
                parsed = json.loads(detail)
            except Exception:  # noqa: BLE001
                parsed = {"error": {"type": "upstream_error", "message": detail[:1000]}}
            self.send_json(exc.code, parsed, {"x-upstream-status": str(exc.code)})
            return
        except Exception as exc:  # noqa: BLE001
            log(f"upstream transport error session={session_id}: {exc}")
            self.send_json(502, {"error": {"type": "upstream_transport", "message": str(exc)}})
            return

        log(f"upstream connected status={response.status} session={session_id} elapsed={time.time() - started:.3f}s")
        content_type = (response.headers.get("Content-Type") or "").lower()
        if not stream or "text/event-stream" not in content_type:
            data = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", content_type or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("x-gateway-mode", self.cfg.effective_mode)
            self.send_header("x-upstream-status", str(response.status))
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()
            log(f"upstream response bytes={len(data)} elapsed={time.time() - started:.3f}s")
            return

        self.begin_sse({"x-upstream-status": str(response.status), "x-opencode-session": session_id})
        bytes_out = 0
        try:
            for raw_line in response:
                self.wfile.write(raw_line)
                bytes_out += len(raw_line)
                self.wfile.flush()
        except Exception as exc:  # noqa: BLE001
            log(f"upstream stream interrupted session={session_id}: {exc}")
        finally:
            log(f"upstream stream complete session={session_id} bytes={bytes_out} elapsed={time.time() - started:.3f}s")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenAI-compatible OpenCode Go gateway for DSH model-gateway")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    parser.add_argument("--mode", choices=["auto", "mock", "live"], default=os.environ.get("GATEWAY_MODE", "auto"))
    parser.add_argument("--upstream", default=os.environ.get("OPENCODE_GO_UPSTREAM_BASE", DEFAULT_UPSTREAM))
    parser.add_argument("--api-key-env", default=os.environ.get("OPENCODE_GO_API_KEY_ENV", "OPENCODE_GO_API_KEY"))
    parser.add_argument("--models", default=os.environ.get("OPENCODE_GO_MODELS", ""), help="comma-separated model ids")
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    config = GatewayConfig(args)
    try:
        server = ThreadingHTTPServer((config.host, config.port), GatewayHandler)
    except OSError as exc:
        log(f"cannot bind {config.host}:{config.port}: {exc}")
        return 2
    server.daemon_threads = True
    server.gateway_config = config  # type: ignore[attr-defined]
    mode = config.effective_mode
    log(f"listening on http://{config.host}:{config.port} mode={mode} upstream={config.upstream} models={[m['id'] for m in config.models]}")
    if mode == "mock":
        log(f"mock mode: set {config.api_key_env} and restart (or use --mode live) to call the real OpenCode Go API")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        log("interrupt received")
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
