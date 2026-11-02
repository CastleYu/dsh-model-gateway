# DSH Model Gateway

A Cordis/DSH Host plugin framework that turns any local model gateway process into a managed DSH model route.

It owns the full lifecycle of a gateway:

- autostart with readiness probing;
- health-check watchdog and crash restart with a bounded exponential backoff;
- graceful stop / process-tree cleanup on plugin unload;
- OpenAI Chat Completions → DSH `StreamChunk` adapter;
- operator tools for status, start/stop/restart, logs and end-to-end self-test;
- bounded internal logs (stdout/stderr, lifecycle traces, HTTP/SSE diagnostics) with secret redaction.

The gateway process remains the adaptation boundary: write a small local server in any language that speaks OpenAI Chat Completions, then declare it in a Cordis patch. DSH no longer needs a separately managed terminal process.

## Repository layout

```
packages/
  dsh-model-gateway/            # framework bundle + OpenCode Go example + tests
  dsh-model-gateway-demo/       # installable demo bundle with a concrete config
```

## Getting started

Read the framework guide:

- [Framework README](packages/dsh-model-gateway/README.md)
- [Worked OpenCode Go gateway](packages/dsh-model-gateway/examples/opencode-go/server.py)
- [Demo bundle patch](packages/dsh-model-gateway-demo/cordis.patch.yml)
- [Custom gateway template](packages/dsh-model-gateway/examples/template/server.py)

Install both local package directories with DSH Plugin Manager's `install_bundle` action, then use the `gateway-status`, `gateway-control`, `gateway-logs` and `gateway-selftest` tools (or select the registered model route in DSH).

The demo gateway runs in `auto` mode: set `OPENCODE_GO_API_KEY` in the DSH launch environment to proxy the real OpenCode Go API, or leave it unset to exercise the complete DSH path against a protocol-faithful mock.

## Verification

- `node --test packages/dsh-model-gateway/test/gateway.test.mjs` — 7/7 passing.
- Live DSH validation: autostart, health check, crash restart, `startOnRequest`, real OpenCode Go streaming (`deepseek-v4.1-flash`, `glm-5.3-flash`), and internal log inspection.

## Scope and limits

- The built-in adapter implements OpenAI Chat Completions only; non-standard upstream protocols are translated inside the gateway process.
- A deployment should keep one configured framework row; multiple gateway processes can live under one `gateways` map.
- Configuration is Cordis patch / bundle based; there is no dedicated Web settings page.
- Windows stops the process tree forcefully; a force-killed DSH cannot run Node cleanup.
