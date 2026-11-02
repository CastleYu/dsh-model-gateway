# Model Gateway Demo

This bundle is the worked example for `@local/dsh-model-gateway`. It installs one
extra `model-gateway` row configured with the bundled OpenCode Go server.

- Framework docs: `../dsh-model-gateway/README.md`
- Gateway program: `../dsh-model-gateway/examples/opencode-go/server.py`
- Route: `gateway-opencode-go`
- Models: `deepseek-v4.1-flash`, `glm-5.3-flash`, `kimi-k3`

Set `OPENCODE_GO_API_KEY` in the environment that launches DSH to proxy the real
OpenCode Go API. Without it the demo gateway runs a deterministic protocol mock,
so DSH integration and lifecycle behavior can be verified without a paid key.
