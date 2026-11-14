# NUMA

> A notch-resident assistant for Windows.

NUMA turns a small desktop notch into a practical assistant: speak or type a
request, let the gateway route it to a verified local action or the agent
lane, and see the result in the notch. The current build includes a calico-cat
NUMA identity, real Windows app discovery and launching, voice I/O, approval
cards, an audit trail, and Composio connectors.

## What it does

- **Notch-first UX** - the Poni native shell owns the notch, microphone,
  playback, global hotkeys, and NUMA's warm dashboard.
- **Real app commands** - requests such as `open Chrome`, `pull up YouTube
  Music`, `open Minecraft`, `open Calculator`, and `open reddit` resolve
  against the machine's installed app inventory rather than a fake app list.
- **Verified execution** - launched apps are checked against Windows process
  and window state before NUMA reports success.
- **Voice path** - Poni sends audio through the gateway for transcription,
  routing, and speech synthesis, then plays the response locally.
- **Connector lane** - GitHub, Gmail, and Todoist actions run through
  Composio MCP with centralized policy, approvals, and execution history.
- **Agent lane** - OpenCode is managed as a service by the gateway for
  questions and coding-oriented requests.

## Architecture

```text
Poni notch / voice
        |
        v
NUMA Gateway :8900
  |-- deterministic app router -> Windows app inventory + verification
  |-- policy, approvals, audit trail, event stream
  |-- Composio MCP connectors
  `-- managed OpenCode service
```

The gateway is the single brain. Poni remains the native notch and presentation
layer; it does not spawn a second agent server.

## Repository layout

```text
crates/poni/              Native Rust notch application
numa-core/gateway/        TypeScript gateway on port 8900
NUMA_ARCHITECTURE.md      System boundaries and execution lanes
NUMA_BUILD_PLAN.md        Implementation status and acceptance criteria
```

## Development

### Gateway

From `numa-core/gateway`:

```powershell
npm install
npm test
npm run typecheck
npm start
```

The gateway expects its local runtime configuration and connected Composio
credentials from the OpenCode environment. It is designed to use the existing
managed OpenCode service rather than launching `opencode serve` itself.

### Poni

Install the Rust toolchain, then from the repository root:

```powershell
cargo build --release -p poni
```

The native app can also run its self-test scenes with the repository's normal
Poni self-test command. See `NUMA_BUILD_PLAN.md` for the current verification
gates and known hardware limitation: wake-word input needs an available
capture device.

## Status

The verified vertical slice is live on Windows: the gateway tests and
type-check pass, Poni's test suite passes, and the app/router lane has been
tested against real installed applications. Browser control, deeper memory,
and additional dashboard work remain planned follow-ups.

## Credit and license

NUMA is a fork and adaptation of **[Oyenza Studio](https://github.com/lucacadalora/oyenza-studio)**,
the original notch application by [Luca Cadalora](https://github.com/lucacadalora).
The upstream project and its notch design are credited here intentionally; see
the upstream repository for its original documentation and history.

This repository retains the upstream MIT license and copyright notice for the
original work. See [`LICENSE`](LICENSE).
