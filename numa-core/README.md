# NUMA Core

Loopback-only provider edge for NUMA. It accepts the WAV produced by PONI and
proxies it to Deepgram Nova-3 pre-recorded English ASR. The Deepgram key is
read by Core from `DEEPGRAM_API_KEY`; it is never passed to or stored by PONI.

```powershell
$env:DEEPGRAM_API_KEY = "..."
node numa-core.mjs
```

The service listens on `127.0.0.1:8899` by default. Override with
`NUMA_CORE_PORT` or `--port`. Endpoints:

- `GET /v1/health`
- `GET /v1/models`
- `POST /v1/audio/transcriptions` with `Content-Type: audio/wav`
- `POST /v1/audio/speech` with `{ "input": "..." }` (Deepgram Aura TTS)
- `POST /v1/chat/completions` with `{ "messages": [{ "role": "user", "content": "..." }] }`

Simple requests use the fast OpenRouter API. Preloaded desktop commands such as
`open spotify`, `pause`, `next track`, `volume up`, and `mute` are handled
locally and do not call a model. NUMA also warms its OpenCode session at Core
startup, so the first memory/coding/tool request does not pay session creation
latency. Requests involving memory, GBrain, files, coding, tools, or longer
context use OpenCode instead.
For that action routing, NUMA uses the authenticated OpenCode user service.
NUMA Core uses `NUMA_OPENCODE_URL` when set, otherwise
`http://127.0.0.1:28894`. The current OpenCode server must have a healthy
session database and a configured model/provider. OpenCode 2 password-protected
servers can be reached by setting `OPENCODE_PASSWORD` to the local service
password. Core discovers an active tools-capable model from `/api/model` and
rejects `openrouter/free`; override with `NUMA_OPENCODE_MODEL=provider/model`.
