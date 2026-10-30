# CoCoon

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Website with screenshots:** https://adziendziold.github.io/cocoon/

**CoCoon** is a self-hosted platform for running AI coding agents – Claude Code, OpenAI Codex, plain shells or any other
CLI – in isolated sandboxes on your own server, and for steering them remotely. It ships with a beginner-friendly web UI
(English and German – follows the browser language), a CLI, an HTTP/WebSocket API and an MCP server, so that other agents can orchestrate
it too. The design is inspired by [herdr](https://vercel.com/docs/sandbox/ecosystem/herdr).

```
 Browser (web UI) · CLI · scripts · Claude Code via MCP
                     │  HTTPS (reverse proxy / VPN / SSH tunnel)
 ┌───────────────────▼───────────────────────────────────────────┐
 │ cocoond  – control plane (Node.js, 127.0.0.1:7420)            │
 │   web UI · REST/RPC · WebSocket events · terminal attach · MCP │
 └───────┬───────────────────────────────────────────┬───────────┘
         │ Docker API                                │ policy
         ▼                                           ▼
  sandbox containers (one per workspace)      egress proxy container
   └ tmux ─ agent processes                    ├ domain allowlist
   └ /workspace (git repo + baseline)          └ credential proxy (API keys)
```

## Contents

- [Features](#features)
- [Quickstart](#quickstart)
- [Using the web UI](#using-the-web-ui)
- [Core concepts](#core-concepts)
- [Sandbox backends](#sandbox-backends)
- [Network modes & security](#network-modes--security)
- [Credentials and custom API providers](#credentials-and-custom-api-providers)
- [Environment variables (.env injection)](#environment-variables-env-injection)
- [Several repositories per sandbox](#several-repositories-per-sandbox)
- [Shared services: databases & mocks](#shared-services-databases--mocks)
- [Servers & ports: previews and sharing](#servers--ports-previews-and-sharing)
- [Orchestration: workspaces, tasks & workflows](#orchestration-workspaces-tasks--workflows)
- [Cockpit](#cockpit)
- [Agent types](#agent-types)
- [Agent status detection](#agent-status-detection)
- [Languages](#languages)
- [Updates](#updates)
- [CLI](#cli)
- [MCP integration](#mcp-integration)
- [HTTP & WebSocket API](#http--websocket-api)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Development](#development)
- [Limitations & roadmap](#limitations--roadmap)
- [Support](#support)
- [License](#license)

## Features

| | |
|---|---|
| **Onboarding wizard** | After installation a guided, full-screen wizard walks new users through system check, AI access (with key verification), GitHub, safety defaults, the first sandbox and the first agent |
| **Cockpit** | herdr-style multi-agent window: tiled live terminals (split, resize, maximize), workspace tree, attention queue, broadcast input, keyboard control, layouts saved per workspace |
| **Scheduled agents** | Agents that run on a schedule (cron + time zone) in a workspace – templates to **run every check** of a project (format, lint, typecheck, unit/integration tests, build, audit), **update dependencies** or do a **security check**. Every run is a task with a report; runs without findings close themselves, findings land in *Review* with a notification |
| **Orchestration** | Workspaces, a task board (backlog → queued → running → review → done), multi-stage workflows (e.g. plan → build → review) with approvals, review feedback loop, dependencies, auto-run with parallelism limits, webhook notifications |
| **Web UI** | Setup checklist, sandbox wizard, live in-browser terminals, file browser/editor, diff viewer, commit/push/pull request, activity log, every setting – written for non-technical users |
| **Sandbox backends** | **Docker**, **Podman** (rootless, no daemon) or **bubblewrap** (lightweight Linux process sandboxes, no images, start in ~0.3 s) – picked automatically. Containers are hardened (non-root, no capabilities, `no-new-privileges`, CPU/RAM/PID limits) with optional gVisor or Kata/Firecracker runtimes |
| **Small footprint** | Slim base image under 250 MB (Debian, no Node.js); agent CLIs and their Node.js runtime live in a shared, read-only **toolbox** that is installed once and updated without rebuilding images |
| **Network control** | Per sandbox: no internet, allowlisted domains only (via egress proxy, default), or open internet. Blocked connections are logged and can be allowed with one click |
| **Credential proxy** | API keys stay on the server – sandboxes only see placeholders, the proxy adds the real key on the way out |
| **Many agents** | Claude Code, OpenAI Codex, OpenCode, Pi, Qwen Code, Gemini CLI and plain shells – switch the agent of a sandbox at any time, with handover of task, changes and last output |
| **Local LLMs** | Each agent is started with the right parameters for your own model server; CoCoon detects which APIs a server speaks and **translates** Anthropic Messages / OpenAI Responses to Chat Completions, so Claude Code and Codex work with chat-only servers (llama.cpp, vLLM, LM Studio, …) |
| **Custom APIs** | Bring your own model endpoint (Anthropic- or OpenAI-compatible: company gateway, LiteLLM, OpenRouter, Ollama, DeepSeek, …) or give agents access to any HTTP API, with model selection and connection test |
| **Previews & ports** | Servers that agents start (dev servers, APIs, docs) are detected automatically and can be opened as an authenticated **preview** in the browser or **shared** on the network – WebSockets/HMR included |
| **Shared services** | One click starts **PostgreSQL, MySQL/MariaDB, MongoDB, Redis** or the mocks **WireMock** (HTTP APIs) and **Mailpit** (email) for all sandboxes – or connects your own server. Every sandbox gets its own database and user; agents get the connection as env vars and may create schemas and test databases freely |
| **Agent status** | `working` / `blocked` / `done` / `idle` / `exited`, from native hooks (Claude Code, Codex) plus screen heuristics |
| **Persistence** | Agents run in tmux inside the sandbox – they survive control-plane restarts and client disconnects |
| **Results** | Changes leave the sandbox only as a git patch, a download, or a pushed branch + GitHub pull request |
| **Integrations** | CLI, typed TypeScript client, REST/RPC, WebSocket events, MCP server |
| **Languages** | UI, server messages and CLI in English and German (browser language, English fallback) |
| **Zero-config start** | Admin token, internal network, egress proxy and sandbox image are set up automatically on first start |

## Quickstart

Requirements: **Node.js ≥ 24**, **pnpm** and one sandbox backend: **Docker**, **Podman** or – on Linux – **bubblewrap** + **tmux**
(see [Sandbox backends](#sandbox-backends)).

```bash
git clone <repository-url> cocoon && cd cocoon
pnpm setup      # install dependencies and build the web UI
pnpm start      # start cocoond on 127.0.0.1:7420
```

On first start the console prints a login link, and the token is also stored in `.data/admin-token.txt`:

```
  CoCoon is running: http://127.0.0.1:7420
  Log in: http://127.0.0.1:7420/?token=cct_…
```

Open the link. In the background CoCoon prepares the sandbox backend – for Docker/Podman it creates the internal network,
builds and starts the egress proxy and builds the slim sandbox image – and installs the agent toolbox (Claude Code, Codex).
This takes a few minutes the first time.

On a fresh installation the **onboarding wizard** opens automatically and guides you through the setup:

| Step | What happens |
|---|---|
| 1. Welcome | What CoCoon is, language choice (optionally also for server messages) |
| 2. System check | Live status of Docker, sandbox image (with build log) and egress proxy |
| 3. AI access | Anthropic API key, Claude subscription token, OpenAI API key or a custom API provider – keys are verified against the provider; rejected keys block the step |
| 4. GitHub *(optional)* | Token for private repositories, push and pull requests, with step-by-step instructions |
| 5. Safety & defaults | Default internet access and size for new sandboxes |
| 6. First sandbox | Name and optional repository – created right away |
| 7. First agent | Pick an available agent type, choose or write a first task, watch its live status |
| 8. Done | Summary, next steps, CLI/MCP tips |

Progress is derived from the server state and kept per browser tab, so you can leave and come back. Completing or skipping the
wizard is stored in `settings.general.onboardingCompletedAt`; installations that are already set up are never redirected. Run it
again anytime from *Settings → General* or the dashboard checklist.

Remote access: cocoond only listens on localhost. Use an SSH tunnel (`ssh -L 7420:127.0.0.1:7420 user@server`), a VPN, or a
TLS reverse proxy (see [Deployment](#deployment)).

Step-by-step guides for beginners: [English](docs/GUIDE.md) · [Deutsch](docs/ANLEITUNG.md).
Architecture and design details (German): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Using the web UI

| Page | What you can do |
|---|---|
| **Onboarding** (`/onboarding`) | Guided first-time setup (see [Quickstart](#quickstart)) |
| **Overview** | Setup checklist with a direct action per step, agents waiting for you, running agents, recent activity |
| **Sandboxes** | List and create sandboxes (wizard: project/repository → internet access → size → advanced: image, runtime, env vars) |
| **Sandbox detail** | *Agents* (start an agent with a task), *Files* (browse, edit, upload, download, new file/folder), *Changes* (diff, download patch, commit, push to GitHub, open a pull request), *Console* (run commands, open an interactive terminal), *Manage* (start/stop/delete) |
| **Agent detail** | Live terminal (type directly), status with plain-language explanation, "waiting for your decision" banner with Yes/No buttons, send messages, quick keys (Enter, Esc, Ctrl+C, arrows, Tab), stop |
| **Agents** | All agents across sandboxes, blocked ones first |
| **Activity** | Live log of everything that happened |
| **Settings** | *General* (language), *Credentials / API keys*, *API providers*, *Agent types*, *Sandbox defaults* (incl. image builds), *Network & security* (allowlist, credential proxy, blocked connections), *Access & integrations* (API tokens, MCP and CLI snippets), *Advanced* (status timings, git author) |

Everything updates live over a WebSocket. The sidebar and browser tab show how many agents are waiting for you.

## Core concepts

- **Sandbox** – an isolated container with its own filesystem. `/workspace` is a git repository: either cloned from a URL
  (optionally a branch/tag/commit, private GitHub repos via `GITHUB_TOKEN`) or empty. A `cocoon-baseline` tag marks the starting
  point, so all changes can be exported as a patch. Lifecycle: `creating → running ⇄ stopped`, plus `error` / `missing`.
- **Agent** – a CLI process in a tmux session inside a sandbox. Several agents can share one sandbox (e.g. planner + implementer).
- **Agent type (profile)** – how an agent is launched and which credentials/providers it gets (see [Agent types](#agent-types)).
- **Secret** – an API key or token stored on the server (`.data/state.json`, mode 0600); falls back to environment variables.
- **API provider** – a custom endpoint agents may use (see [below](#credentials-and-custom-api-providers)).
- **Settings** – all runtime configuration, editable in the UI or via `settings.update`.

## Sandbox backends

CoCoon talks to sandboxes through a small driver interface, so the isolation technology is interchangeable:

| Backend | What it is | Footprint | Isolation | Notes |
|---|---|---|---|---|
| **Podman** | Container engine without a background daemon, runs rootless | small, no root service | containers (+ gVisor / Kata / krun runtimes) | uses Podman's Docker-compatible API socket |
| **Docker** | The standard container engine | daemon (~100 MB), root | containers (+ gVisor / Kata runtimes) | Docker Desktop on macOS/Windows |
| **bubblewrap** | Linux process sandboxes (namespaces, as used by Flatpak and Claude Code's own sandbox) | tiny – no daemon, no images | user/pid/ipc/uts/(net) namespaces, read-only host, no capabilities | Linux only; shares the host kernel and installed tools; **no resource limits and "Restricted" network is not enforced** (proxy is configured, but could be bypassed) |

Selection: `COCOON_DRIVER=auto` (default) uses an explicit `DOCKER_SOCKET`, then a Podman socket, then Docker, then bubblewrap.
Force one with `COCOON_DRIVER=docker|podman|bwrap`. The UI shows the active backend and its capabilities
(*Settings → Sandbox defaults*), and `system.info` reports `driverKind` and `capabilities`.

- **Podman:** enable the API socket – rootless `systemctl --user enable --now podman.socket` (socket under
  `$XDG_RUNTIME_DIR/podman/podman.sock`) or rootful `systemctl enable --now podman.socket`. On macOS, `podman machine` works too.
  Containers reach the host as `host.containers.internal`. The egress proxy also joins the network `cocoon-egress`
  (not internal, DNS enabled), because Podman's DNS on an internal network does not resolve external names; sandboxes are never attached to it.
- **bubblewrap:** `apt install bubblewrap tmux git` (or `dnf install …`); unprivileged user namespaces must be allowed (default on
  most distributions). Each sandbox is a directory under `.data/sandboxes/<id>` (workspace, home, tmp); the host system is mounted
  read-only, a long-running *keeper* (tmux server) per sandbox keeps agents alive across cocoond restarts, and the egress proxy runs
  as a local process on `127.0.0.1:7431/7432` (`COCOON_PROXY_PORT`). Sandbox options and secrets are passed to `bwrap` via a file
  descriptor, so they never show up in the host's process list.

**Agent toolbox:** the agent CLIs – and the Node.js runtime they need – are not part of the sandbox image. They are installed once
(`npm install -g --prefix /opt/agents …`) into a Docker/Podman volume (`cocoon-agents`) or `.data/agents` for bubblewrap, and
mounted **read-only** at `/opt/agents` in every sandbox (`PATH` includes `/opt/agents/bin`, also in login shells; self-updaters are
disabled). Docker/Podman install with `node:24-bookworm-slim` and copy its `node`, `npm`, `npx` and `corepack` into the toolbox;
bubblewrap copies the Node.js that runs CoCoon. Install or update them in *Settings → Sandbox defaults* or via
`image.build({ kind: "agents" })` – no image rebuild needed. A toolbox installed by an older CoCoon (without Node.js) is reinstalled
automatically on the next start.

**Sandbox image variants** (`images/sandbox`, Debian `bookworm-slim`, build argument `TOOLCHAIN`; pick one in
*Settings → Sandbox defaults*, `image.build({ kind: "sandbox", variant })` or `pnpm build:image[:db|:full]`):

| Variant | Contents | Size |
| --- | --- | --- |
| `slim` *(default)* | bash, git, tmux, ripgrep, curl, jq, less, procps, CA certificates | < 250 MB (checked in CI) |
| `db` | `slim` + database clients: `psql`, `mysql`/MariaDB, `redis-cli` – handy with [shared services](#shared-services-databases--mocks) | + ~100 MB |
| `full` | `db` + compilers (`build-essential`) and Python 3 for projects that build native code | + ~400 MB |

Debian rather than Alpine on purpose: the agent CLIs ship glibc binaries (Claude Code, Codex, OpenCode) and most projects' prebuilt
native modules assume glibc too. CI builds every variant, checks its contents and fails if `slim` reaches 250 MB; multi-arch
(amd64/arm64) builds are published as `ghcr.io/<owner>/cocoon-sandbox:{slim,db,full}` (`.github/workflows/images.yml`).

**Agent secrets** are written to a private file (mode 0600) that the agent's session sources and deletes immediately, so API keys
never appear in a command line (`ps`/`docker top`).

## Network modes & security

| Mode | Implementation | Use for |
|---|---|---|
| `egress` *(default, "Restricted")* | Docker/Podman: the sandbox is only attached to the internal network `cocoon-internal` (no gateway, no external DNS); the only way out is the egress proxy (`HTTP(S)_PROXY` is preset): allowlisted domains, ports 80/443, known sandboxes only. bubblewrap: proxy configured, not enforced | Normal work – agents can reach model APIs, GitHub, npm, PyPI |
| `open` | Bridge network / host network, unrestricted internet | Projects that need arbitrary downloads |
| `none` | No network at all | Untrusted code, offline analysis |

**Egress proxy** (`images/egress-proxy`, dependency-free Node.js, read-only container, no capabilities):
- `:3128` forward proxy enforcing the domain allowlist (`*.example.com` matches subdomains). Denied attempts appear under
  *Settings → Network & security* with an "Allow" button.
- Sandboxes are identified by a per-sandbox token (`Proxy-Authorization` / `/t/<token>/` path prefix) or, on the internal container
  network, by their IP.
- `:8080` credential proxy: agents call `http://cocoon-proxy:8080/t/<token>/<route>/…`; the proxy swaps placeholders
  (`cocoon_<sandboxToken>_<SECRET>`) for real keys or injects the provider's auth header, then forwards over TLS.
  A sandbox may only use a route after an agent using it was started there.
- cocoond writes the policy to `.data/egress/policy.json`; the proxy reloads it immediately and acknowledges the version,
  so e.g. a repository clone only starts once the proxy knows the new sandbox.

**Sandbox hardening:** non-root user, `CapDrop: ALL`, `no-new-privileges`, CPU/memory/PID limits, `/tmp` as tmpfs, init process,
`RestartPolicy: unless-stopped`. Optional runtimes (must be installed on the host and registered with Docker; the UI only offers
available ones): `runsc` = gVisor user-space kernel, `kata-fc` = Kata Containers with Firecracker microVMs.

**Control plane:** binds to `127.0.0.1` by default. API tokens are stored as SHA-256 hashes and compared in constant time.
Admin methods (settings, secrets, tokens, images) are not exposed via MCP. Git credentials are passed per command as `GIT_CONFIG_*`
variables and never written into the sandbox. Note: with Docker, cocoond needs the Docker socket, which is root-equivalent – run
it as a dedicated user on a dedicated host, or prefer rootless Podman / bubblewrap, which need no root at all.

## Credentials and custom API providers

### Built-in credentials (*Settings → Credentials / API keys*)

| Secret | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Code (via credential proxy in egress mode) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with a Claude Pro/Max subscription (`claude setup-token`) |
| `OPENAI_API_KEY` | Codex (via credential proxy in egress mode) |
| `GITHUB_TOKEN` | Private repositories, push, pull requests (fine-grained token: *Contents* + *Pull requests* read/write) |

Any other secret name can be added and referenced by agent types or providers.

### Custom API providers (*Settings → API providers*)

Use your own model endpoint instead of (or in addition to) the default access, or give agents access to any HTTP API.

| Kind | The agent receives | Typical targets |
|---|---|---|
| `anthropic` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` for bearer auth), `ANTHROPIC_MODEL` | Company gateway, LiteLLM, DeepSeek, Bedrock proxy – for **Claude Code** |
| `openai` | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (+ `--model` for Codex) | OpenRouter, Groq, Mistral, Ollama, vLLM – for **Codex** and other tools |
| `http` | `<PREFIX>_BASE_URL`, `<PREFIX>_API_KEY` | Any REST API, e.g. internal services |

Each provider has a base URL, the name of the secret holding its key, an auth mode (`bearer`, `x-api-key`, custom header, none),
a list of models and a default model. The UI offers templates (OpenRouter, Ollama, LiteLLM, DeepSeek, Groq, Mistral, custom
Anthropic/OpenAI/HTTP) and a **Test connection** button (`providers.test`) that checks reachability and authentication from the
server and discovers available models – even before saving.

How it is wired:
- In `egress` mode the base URL points to the credential proxy (`http://cocoon-proxy:8080/p-<id>`), which adds the real key.
  In `open` mode the agent talks to the provider directly.
- `localhost` in a base URL is rewritten to `host.docker.internal`, so services on the server itself (e.g. Ollama) work.
- Provider hosts are added to the egress allowlist automatically.
- If a profile uses an `anthropic` provider, the default `ANTHROPIC_API_KEY` is not injected (same for `openai` / `OPENAI_API_KEY`).
- Assign providers per agent type (`providers`, `model`) or per start (`agent.spawn { providers, model }`).

## Environment variables (.env injection)

Projects need their own configuration – a Stripe test key, a database URL, a Sentry DSN, feature flags – to run their tests.
Define it once and CoCoon injects it into sandboxes and agents, instead of typing variables for every sandbox or committing a `.env`.

**Levels** (*Workspace page → Settings*, *Sandbox page → Environment*, `cocoon env …`); later levels override earlier ones:

| Level | Applies to | Identified by |
|---|---|---|
| **Workspace** | every sandbox of the workspace | workspace |
| **Repository** | every sandbox that clones the repository, in any workspace | the repository URL – `https://github.com/o/r.git`, `git@github.com:o/r` and `ssh://git@github.com/o/r` are the same repository |
| **Sandbox** | this sandbox | sandbox |
| **Agent type** | agents of that type | *Settings → Agent types* (`env`), as before |

The sandbox page shows the merged result with the origin of every value (and what it overrides). `agent.spawn { env }` and CoCoon's own
variables (credentials, provider wiring, `COCOON_*`) still come last. With several repositories in a sandbox, the agents get the
variables of all of them (later repository wins); each repository's `.env` file only gets its own level.

**Two ways to inject, per variable** (`target`):

- `env` – environment variables of agents started afterwards and of `sandbox.exec` (never in the container's own configuration, so not in `docker inspect`).
- `file` – a `.env` file in the repository folder (`/workspace/.env`, or `/workspace/<folder>/.env` per repository; the path is configurable per level).
  CoCoon adds the file to the repository's `.git/info/exclude` **before** it creates it, so it never appears in `git status`, diffs, commits,
  patches or pushes. It is written with mode `0600`, starts with a `# cocoon-managed` line, and CoCoon never overwrites or removes a file
  without that line, never writes into a folder that is not a git repository and never into a `.env` the repository tracks (all reported as *skipped*).
  Note that an agent can read the file – use the proxy for keys the agent does not need to see.
- `both`.

**Updates**: new agents get the current values immediately; the `.env` file is re-written when a sandbox is created or started and
before every agent start. *Apply now* (`cocoon env apply`, `env.apply`) updates a running sandbox without starting an agent.
Changing the file path of a level does not remove the file at the old path.

**Secrets**: values are encrypted at rest (AES-256-GCM; key in `<data dir>/env.key`, mode `0600`, kept apart from `state.json` and bound
per variable), masked in the UI and API (`env.get`, `env.resolve`, `sandbox.get`, the activity log – only variables marked *not secret* show
their value) and never logged. The `env.*` methods are admin-only and not offered over MCP. Names starting with `COCOON_` and the proxy
variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, …) are reserved. Back up `env.key` together with `state.json`; without it the stored values
cannot be decrypted (they are skipped and have to be set again).

**Credential proxy**: mark a variable as *API key for host X* (`proxyHost`, e.g. `api.stripe.com`, optional port, `http://` for internal APIs).
The sandbox gets a placeholder (`cocoon_<token>_STRIPE_API_KEY`) plus a base URL (`STRIPE_BASE_URL`, or `baseUrlEnv`) pointing at the
credential proxy; the proxy swaps the placeholder for the real value – in `Authorization: Bearer …`, other headers and `Basic` credentials –
only for requests to that host and only for that sandbox. The real value never enters the sandbox, not even in the `.env` file.
The application has to call the base URL (most SDKs have a setting for it); HTTPS traffic that bypasses it is a tunnel the proxy cannot rewrite.
Without a credential proxy (sandbox network *none*, or the API key protection switched off) such a variable is **not injected at all**
and flagged in the merged view – it is never handed over in plain text. Proxied variables are sandbox-wide: if two repositories define the
same proxied name, the later one wins everywhere.

```bash
pnpm cocoon env set --workspace ws_… STRIPE_KEY=sk_test_… --target both
pnpm cocoon env set --repo https://github.com/acme/api.git DATABASE_URL=postgres://… 
pnpm cocoon env set --sandbox sb_… SENTRY_DSN --stdin < dsn.txt          # keeps the value out of the shell history
pnpm cocoon env set --repo github.com/acme/api STRIPE_API_KEY=sk_test_… --proxy-host api.stripe.com
pnpm cocoon env set --sandbox sb_… --file-path config/.env.test          # where the .env file goes
pnpm cocoon env import .env --repo github.com/acme/api [--target file] [--replace]
pnpm cocoon env ls --workspace ws_…             # one level (secrets masked)
pnpm cocoon env ls --sandbox sb_… --merged      # what the sandbox gets, with origins   (--agent <type> to include it)
pnpm cocoon env rm --sandbox sb_… SENTRY_DSN
pnpm cocoon env apply sb_…                      # write the .env files now
```

## Several repositories per sandbox

A platform made of several services (API, web app, workers, shared libraries …) often lives in several repositories.
A sandbox can hold any number of them, so one agent can work across all of them at once:

```
/workspace
├── api/        ← https://github.com/acme/api.git
├── web/        ← https://github.com/acme/web.git (branch develop)
└── shared/     ← https://github.com/acme/shared-types.git
```

- **Create**: add more repositories in the sandbox wizard (*+ Add another repository*), in a workspace (all task
  sandboxes get them) or with `--repo` repeated on the CLI. Each one gets its own folder – derived from the URL or
  chosen freely (`services/api`). A single repository without a folder is still cloned into `/workspace` itself.
- **Add later**: *Add repository* on the sandbox page (`sandbox.add_repo`, `pnpm cocoon repo add`), remove with
  `sandbox.remove_repo`.
- **Git per repository**: status, commit, push and pull request work per folder (repository selector in the UI,
  `--repo <folder>` on the CLI, `repo` parameter in the API/MCP). The *Changes* view shows all repositories; a
  combined patch has folder-prefixed paths. `git.repos` lists branch and number of changes per repository.
- **Agents know the layout**: they start in `/workspace` and get a short note listing the folders and their remotes;
  Codex trusts every repository folder; when switching agents, the handover lists the changes per repository.

## Servers & ports: previews and sharing

When an agent starts a server in a sandbox, it shows up under *Sandbox → Ports* within a few seconds (CoCoon reads the
listening TCP ports of every running sandbox). From there:

- **Open preview** – opens the server in the browser, only for people logged in to CoCoon. The preview runs on its own host
  name, `http://p<port>-<sandbox>.localhost:7420/` (browsers resolve `*.localhost` to the local machine), or
  `https://p<port>-<sandbox>.<COCOON_PREVIEW_DOMAIN>/` with a wildcard domain behind your reverse proxy. When CoCoon is opened
  from another machine (e.g. via Tailscale Serve, where `*.localhost` would point to your own computer) and no preview domain
  is set, the link is path-based instead: `<CoCoon URL>/preview/p<port>-<sandbox>/` (cookie scoped to that path, prefix stripped
  before it reaches the app and sent as `X-Forwarded-Prefix`; apps with absolute asset paths need a base path setting). The link contains a
  one-time token that is exchanged for a cookie valid for that preview only. The app sees `Host: localhost:<port>`, so dev
  servers that only allow localhost (e.g. Vite) work, and WebSockets / hot reload are proxied as well.
- **Share on the network** – publishes the server on a host port (`http://<host-ip>:7550`) for everyone who can reach the
  machine, without login. Opt-in per port, logged in the activity log, can be turned off entirely.

How it works: a small gateway container (`cocoon-ports`, runs in the egress-proxy image) sits on the internal network and the
bridge and publishes two host port ranges – `127.0.0.1:7500-7549` for previews and `0.0.0.0:7550-7599` for shared ports.
cocoond writes which host port goes to which sandbox port; changes apply immediately and close existing connections of a
closed port. Opened ports survive stopping and starting the sandbox and are removed with it.

Servers must listen on all addresses – `npm run dev -- --host 0.0.0.0`, `python -m http.server --bind 0.0.0.0`. Servers
bound to localhost only are listed as *internal only*; CoCoon tells agents about this in their notes.

```bash
pnpm cocoon ports ls <sandbox-id>
pnpm cocoon ports open <sandbox-id> 5173            # preview, prints a one-time link
pnpm cocoon ports open <sandbox-id> 5173 --shared   # reachable on the network
pnpm cocoon ports close <sandbox-id> 5173
```

Available with Docker and Podman (not yet with bubblewrap), in network modes *Restricted* and *Open*.

## Shared services: databases & mocks

Agents often need a database or a fake external API to run tests. Instead of installing one into every sandbox,
CoCoon runs them **once on the server** and gives every sandbox **its own isolated slice**
(*Settings → Services*, or `pnpm cocoon services add postgres`).

| Service | Kind | What each sandbox gets | Env vars for agents |
|---|---|---|---|
| PostgreSQL 17/16 | database | own database + user (`sb_<id>`), may create schemas and extra (test) databases | `DATABASE_URL`, `POSTGRES_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` |
| MySQL 8.4 / MariaDB 11 | database | own database + user, may create databases named `sb_<id>_…` | `MYSQL_URL`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` (`DATABASE_URL` if no PostgreSQL) |
| MongoDB 8/7 | database | own database + user (`dbOwner`) | `MONGODB_URI`, `MONGO_URL` |
| Redis 7/8 | database | own ACL user limited to keys/channels `sb_<id>:*` | `REDIS_URL`, `REDIS_KEY_PREFIX` |
| WireMock 3 | mock | own URL prefix `/sb_<id>`; its stubs are removed with the sandbox | `MOCK_API_URL`, `WIREMOCK_URL`, `WIREMOCK_ADMIN_URL`, `MOCK_API_PREFIX` |
| Mailpit | mock | shared mailbox: mail sent via SMTP never leaves the server, readable via API and web UI | `SMTP_HOST`, `SMTP_PORT`, `SMTP_URL`, `MAILPIT_API_URL` |

Every service also gets `COCOON_<ID>_URL`, so a second instance of the same kind (e.g. `postgres-2`) is usable too.

**How it works**

- **Managed** (default, Docker/Podman): CoCoon pulls the official image, starts `cocoon-svc-<id>` with a data volume
  and a random admin password, joins it to the internal network (sandboxes reach it by its id, e.g. `postgres:5432`)
  and publishes its port on `127.0.0.1` only, for CoCoon itself and database tools on the server
  (*Credentials for database tools* in the UI, `pnpm cocoon services credentials <id>`).
- **External** (databases): connect an existing server with an admin user that may create databases and users.
  Container sandboxes reach it through a TCP relay in the egress proxy (so `localhost` = the CoCoon server works
  even for restricted sandboxes); bubblewrap sandboxes connect directly.
- **Automatic per sandbox**: services set to *every sandbox* are attached when a sandbox is created (choose others
  in the sandbox dialog); new services can be attached to existing sandboxes. Deleting a sandbox drops its databases,
  users, keys and stubs. *Empty* (`services reset`) gives a sandbox a clean database with the same credentials.
- **Agents know about it**: on start, agents get the env vars, `/opt/cocoon/services.env` is sourced by shells, and
  a short "shared test services" section is written into each agent's user memory (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, OpenCode, Pi, Gemini, Qwen). The sandbox image includes `psql`, `mariadb` and `redis-cli`.
  Running agents need a restart to see newly attached services.
- **One instance, not one per sandbox**: each service runs once (e.g. PostgreSQL ~60 MB RAM); another sandbox only
  adds its own database (a few MB on disk).
- **Paused when unused** (default, per service): a managed service that no running sandbox has used for 10 minutes
  is stopped (status *Paused*, no memory used) and starts again automatically when an agent or a sandbox with that
  service starts – usually within seconds. Turn it off per service to keep it running.
- Restricted sandboxes get the service hosts in `NO_PROXY`; sandboxes without network cannot use services.
- Agents can manage their services themselves over MCP (`services_list`, `services_connections`,
  `services_attach`, `services_reset`, …).

Isolation is meant for development and tests: sandboxes cannot read each other's databases, but they share the
server's resources, and WireMock/Mailpit are shared by design (prefixes keep stubs apart).

## Orchestration: workspaces, tasks & workflows

The orchestration logic runs **in the server**, so it keeps working when no browser is open and is available to the UI,
the CLI, the API and MCP alike (a lead agent can orchestrate just like you).

**Workspaces** group sandboxes, agents and tasks – e.g. one per project or customer. A workspace can define a repository that is
cloned into task sandboxes, a network mode, and a sandbox strategy: `per-task` (every task gets its own sandbox – parallel and
isolated, default) or `shared` (all tasks work in one sandbox – an existing sandbox of the workspace is taken over before a new
one is created). Default agent type / workflow, `autoRun` and `maxParallel` complete the setup.

A task can also be pinned to an existing sandbox of its workspace (*Sandbox* in the task dialog; a running one is preselected).
When a task that got **its own sandbox** is accepted, CoCoon commits all changes, pushes them as branch `cocoon/<task>-<id>` and
removes the sandbox. If the push fails (e.g. no GitHub token), the task stays in *Review* and the sandbox is kept. Shared and
hand-picked sandboxes are kept.

**Tasks** live on a board and move through:

```
backlog ──▶ queued ──▶ running ──▶ review ──▶ done
   ▲          (auto-run)   │  ▲        │
   └──── stop ─────────────┘  └─reject─┘ (feedback goes to the agent)      running ──▶ failed (agent error)
```

- `task.start` creates/uses the sandbox and spawns the agent; the task status then **follows the agent**: blocked agents set
  `attention`, a finished agent moves the task to `review` (you look at the result), errors to `failed` with a note.
- `task.approve` continues with the next workflow stage or marks the task `done`; `task.reject` sends your feedback to the agent
  (or a new agent of the same stage) and the task runs again.
- **Failed, but actually finished?** If the agent of a `failed` task becomes active again or finishes after all (e.g. it
  was declared gone during a server restart, or you continued it in the cockpit or switched agents), the task follows it
  again. `task.mark_finished` moves a `failed` task to `review` by hand, so you can approve it (or send it back).
- `dependsOn` – a task only starts when all its dependencies are `done`.
- **Auto-run**: in workspaces with `autoRun`, queued tasks are started automatically (high priority first) up to `maxParallel`.
- Every stage run is recorded in `runs` (stage, agent, outcome). Running tasks are reconciled after a server restart.

**Task numbers and branches.** Every workspace has a short **key** (derived from its name, e.g. `FocusDigital` → `FD`,
editable) and numbers its tasks: `FD-1`, `FD-2`, … The handle is shown on cards and in the drawer, and gives the task's **git
branch** `FD-12-add-apple-pay` – a sandbox created for a task works on it from the start, pushes and pull requests use it.
Prompts can use `{{task.key}}` and `{{task.branch}}`.

**Code review when approving** (workspace setting). Approving a finished task then starts **review agents one after another
in the same sandbox** instead of pushing right away. Each reviews the full diff, may fix small problems, and reports a verdict
(`approved` / `changes_requested` + summary) in a file outside the repositories.
- *Changes requested* (or no result) → the task goes back to *Review* with the summary; *Request changes* sends it to the
  working agent, *Approve* runs the review again.
- *All approved* → CoCoon commits, pushes the task branch and opens a **pull request** per changed repository (target: the
  configured base branch or the repository default; repositories outside GitHub are only pushed). A sandbox that belonged to
  the task alone is removed. The drawer shows the reviews and the pull request links.
- *Review agent may push and open the pull request itself* gives the **last** review agent the GitHub token (`GITHUB_TOKEN` /
  `GH_TOKEN`) – off by default; all other review agents get the token removed. If no token is stored, the task goes back to
  *Review* with a clear note instead of starting the agent. Use a fine-grained token limited to the repositories.
- Reviewers commit their own fixes (`Review fixes: …`); their verdict file lives in `<workspace>/.cocoon/`, which is excluded
  from every repository.

**GitHub access for agents.** Agent types that list `GITHUB_TOKEN` in their secrets (Claude Code, Codex and OpenCode by
default) get the stored token in their environment, and CoCoon sets up a git credential helper for github.com, so plain
`git push` works for them. Remove `GITHUB_TOKEN` from an agent type (*Settings → Agent types*) to keep it away from that agent.

**Workflows** (*Settings → Workflows*) chain stages, each a fresh agent in the task's sandbox. Prompt templates may use
`{{task}}`, `{{task.title}}`, `{{task.description}}`, `{{previous.output}}` (last screen of the previous stage),
`{{diff}}` (changed files) and `{{feedback}}` (review feedback). Stages with `approval` pause in `review` until you approve.
Built-in: **Plan → Build → Review** (approve the plan before implementation) and **Build → Review**.

**Scheduled agents** (*Schedules* in the navigation, or the *Schedules* tab of a workspace) start a task on a schedule:
"run all checks every night at 03:00", "look for dependency updates every Monday", or anything you write yourself.

- **When**: hourly / daily / weekdays / weekly / monthly in the UI, or any five-field **cron expression**
  (`minute hour day month weekday`, with lists, ranges, steps, names and `@daily`-style macros), evaluated in an **IANA time
  zone** (daylight saving time included). The dialog previews the next runs.
- **Templates** prefill the instructions (editable): **Run all checks** – the agent discovers every check of the project (package
  scripts, Makefile, CI config, pyproject, Cargo, …) and runs formatting, linting, type checking, unit/integration tests, build and a
  dependency audit, without changing code; **Update dependencies** – lists outdated packages and vulnerabilities, applies patch/minor
  updates and security fixes, runs all checks, reverts what breaks, lists major updates with migration notes and commits;
  **Security check**; **Own task**.
- **Each run is a task** (`Name · 2026-10-17 03:00`) that is started right away (independent of auto-run) with the schedule's
  agent type or workflow, in a fresh sandbox (per-task workspaces) or the shared sandbox.
- **Report**: the last agent of a run writes `{"status": "ok" | "action_needed", "summary", "report"}` to
  `<workspace>/.cocoon/report/<task>.json` (excluded from git; the path is also in `$COCOON_REPORT_FILE`, so a plain shell
  command can write it, e.g. `pnpm test && echo '{"status":"ok"}' > "$COCOON_REPORT_FILE"`). The task drawer shows it.
- **Auto-close** (default on): runs whose report says `ok` are marked done and their sandbox is removed – no review needed.
  Findings, changed files or a missing report move the task to *Review* (notification "Scheduled run needs you"); approving it
  then works like any task (push, code review, pull request).
- **Overlap** (default *skip*): no new run while the previous one is still queued, running or waiting for review, so the same
  task does not pile up; *Run now* can force an extra run. Runs missed while the server was down are made up once on start.
- **Housekeeping**: only the newest `keepRuns` (default 10) finished runs are kept; older ones are deleted with their sandbox.
  The schedule list shows next/last run, the last result and a coloured history of recent runs.

**Notifications** (*Settings → Notifications*): an incoming webhook (Slack, Mattermost, Discord via `/slack`, or any JSON
endpoint) receives `{ text, content, event, url }` when an agent is waiting for you, a task is ready for review, failed or done.
Messages use the server's default language; set `COCOON_PUBLIC_URL` to get links.

## Cockpit

The cockpit (`/cockpit`) is the "agent window" for working with many agents at once: a tiled layout of live, interactive agent
terminals next to the workspace tree and the attention queue (blocked agents, tasks in review). Panes can be split, resized,
maximized and swapped; layouts are saved per workspace on the server (`layout.get/save`), so they look the same on every device.
- **Rail:** "Waiting for you" (blocked agents with Yes/No, tasks in review with Approve/Request changes), then the tree
  Workspace → Sandbox → Agent. Drag an agent onto a pane or click it to show it in the focused pane.
- **Panes:** live agent terminal, compact task board, attention list, or empty picker. Splitting, closing and swapping panes never
  restarts a terminal; dividers can be dragged. Presets: *Grid* (all running agents), *2 columns*, *Focus + sidebar*.
- **Broadcast:** tick several pane headers and send one message to all of those agents.
- **Board integration:** task cards link to `/cockpit?agent=<id>`; dragging cards on the board starts (→ Running), stops
  (Running → Backlog) or approves (Review → Done) tasks.
- Only visible panes connect (max. 12 live terminals); below 1024 px the cockpit shows the attention list instead.

| Shortcut (Ctrl+Alt or ⌘+Alt) | Action |
|---|---|
| ← ↑ → ↓ | move focus to the neighbouring pane |
| 1–9 | jump to pane N |
| Enter | maximize / restore |
| D / W | split / close pane |
| G | auto-grid |
| B | broadcast |
| `?` or `/` | shortcut help |

## Agent types

Built-in types (editable, resettable). The CLIs live in the shared toolbox – install the ones you want under
*Settings → Sandbox defaults → Agent tools* (default: Claude Code, Codex, OpenCode, Pi).

| Type | CLI (npm package) | Custom/local models | Notes |
|---|---|---|---|
| `claude-code` | `claude` (`@anthropic-ai/claude-code`) | Anthropic Messages – or any chat server via translation | status hooks, onboarding/trust dialogs skipped |
| `codex` | `codex` (`@openai/codex`) | OpenAI Responses – or any chat server via translation | `notify` hook, workspace trusted, runs with `--sandbox danger-full-access` (CoCoon isolates) |
| `opencode` | `opencode` (`opencode-ai`) | Chat / Messages / Responses natively | config passed via `OPENCODE_CONFIG_CONTENT`, `-m cocoon/<model>` |
| `pi` | `pi` (`@earendil-works/pi-coding-agent`) | Chat / Messages / Responses natively | provider written to `~/.pi/agent/models.json`, `--provider cocoon --model …` |
| `qwen-code` | `qwen` (`@qwen-code/qwen-code`) | Chat natively | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`, `-m` |
| `gemini` | `gemini` (`@google/gemini-cli`) | – (Gemini API key only) | |
| `shell` | `bash -l` | env vars only | prompt typed into the terminal |

A profile defines `command`, `promptMode` (`arg` | `input`) and `promptFlag`, `adapter` (how providers are wired in;
derived from the command if omitted), `tool`, `secrets`, `env`, `providers`, `model`, `hooks`, `workingPatterns`,
`blockedPatterns` and `idleForeground`.

**Skills:** a profile can list `skills` – GitHub references such as `owner/repo`, `owner/repo/path/to/skill` or
`owner/repo@v1` (also `https://github.com/…` and `/tree/<ref>/<path>` URLs). When an agent of this type starts, CoCoon
clones each repository (shallow) inside the sandbox and copies every folder containing a `SKILL.md` into the CLI's skills
folder (`~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills`, `~/.config/opencode/skills`, `~/.pi/agent/skills`,
`~/.qwen/skills`). A path pointing at a skill installs that one; otherwise all skills directly in the folder (or its
`skills/` subfolder) are installed. Needs sandbox internet access; private repos use the sandbox's GitHub token.
Create e.g. a "Claude Code + Ponytail" agent type by duplicating Claude Code and adding the skill.

**Switching agents:** `agent.switch` (UI: *Switch agent* on the agent page or in a cockpit pane) starts another agent type – with
its own provider/model – in the same sandbox. With *handover* the new agent receives the original task, a `git diff --stat` of the
changes so far and the previous agent's last output; the previous agent is stopped and a running task follows the new agent.

### Local LLMs

Add your server under *Settings → API providers* (kind *OpenAI-compatible* for llama.cpp, vLLM, LM Studio, Ollama …; *Anthropic-
compatible* for gateways speaking `/v1/messages`) and click *Test connection*: CoCoon lists the models and probes which API styles the
server speaks (Chat Completions, Responses, Anthropic Messages). When an agent is started with that provider, CoCoon

1. picks the API style the agent speaks natively, or – for Claude Code and Codex on chat-only servers – routes it through the
   **translating credential proxy** (Anthropic Messages ↔ Chat, Responses ↔ Chat, including streaming and tool calls),
2. passes the agent-specific start parameters / config (see table above) and the model (required: chosen at start, the agent
   type's model, the provider's default model or the first discovered one),
3. passes the model's **context window and answer length**, so the agent compacts its history in time and never sends more than
   the model can handle (Claude Code: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; Codex:
   `model_context_window` / `model_auto_compact_token_limit`; OpenCode: `limit.context` / `limit.output`; Pi: `contextWindow` /
   `maxTokens`; Qwen Code: `model.sessionTokenLimit`). The connection test reads the limits from the server where it reports them
   (llama.cpp `--ctx-size` in router listings, vLLM `max_model_len`, OpenRouter `context_length`, LM Studio `max_context_length`, …);
   they can be set or overridden per model, per agent type and per start. The answer length defaults to a quarter of the context
   window (1k–32k), and the translating proxy caps requests to it,
4. keeps the key on the server (the proxy injects it).

Translation runs in the credential proxy, which serves every sandbox with network access (identified by its token) as long as
*API key protection* is on. Tested end to end with a
llama.cpp-based server (chat only) and Claude Code, Codex, OpenCode and Pi. Example of a fully autonomous Claude Code
(safe because it runs in a sandbox):

```json
{
  "claude-yolo": {
    "label": "Claude Code (autonomous)",
    "command": ["claude", "--dangerously-skip-permissions"],
    "promptMode": "arg",
    "hooks": "claude-code",
    "secrets": ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"]
  }
}
```

## Agent status detection

| Status | Meaning |
|---|---|
| `working` | busy |
| `blocked` | waiting for a human decision (permission prompt, y/n question, …) |
| `done` | finished the task it was given |
| `idle` | waiting, no open task |
| `exited` | process ended (exit code available) |
| `unknown` | could not be determined |

Two sources, reported as `statusSource`:
1. **Hooks** – installed into each sandbox: Claude Code hooks in `~/.claude/settings.json` (`UserPromptSubmit`/`PreToolUse`/`PostToolUse`
   → working, `Notification[permission_prompt]` → blocked, `Stop` → done) and Codex `notify` in `~/.codex/config.toml` (→ done).
   They write to `/opt/cocoon/status/<agentId>` – no network access to the control plane needed.
2. **Heuristics** – a poller takes one snapshot per sandbox per second (tmux state, foreground process, screen): changing screen →
   working; quiet with a permission prompt visible → blocked; quiet after a task → done.

Hook reports win. If a hook says "working" but the screen has been quiet for 15 s (e.g. an API error without a `Stop` hook),
the heuristic takes over. Statuses survive control-plane restarts.

## Languages

- The web UI is available in **English** and **German**. It follows the browser language (German browsers get German,
  everything else English) and can be switched in the sidebar footer or on the login page; the choice is stored per browser. Dates and numbers follow the selected locale.
- The server localizes error messages, the activity log and the setup checklist per request: header `x-cocoon-lang` or query
  `?lang=` → `Accept-Language` → `settings.general.language` (default `en`, used for CLI/API/MCP and console output).
- CLI: `--lang en` or `COCOON_LANG=en`.

## Updates

*Settings → Updates* (or `pnpm cocoon update`) shows whether everything is current and updates it with one click:

| Part | Checked against | Update |
| --- | --- | --- |
| **CoCoon** | the upstream branch of the git clone (`git fetch`) | `git merge --ff-only`, `pnpm install --frozen-lockfile`, web build, restart. If a step fails, CoCoon goes back to the previous commit. Not offered with local changes to tracked files or diverged history. |
| **Agent tools** | the `latest` version on npm | reinstalls the installed tools into the toolbox |
| **Images** | CoCoon's Dockerfile (fingerprint stored as image label) and the registry digest of the base image | pulls the base image and rebuilds in the variant of the existing image (`slim`, `db`, `full`); existing sandboxes keep their image. A toolbox without its own Node.js is reinstalled along with it |

CoCoon checks once a day by itself (`COCOON_UPDATE_CHECK=0` turns this off) and shows a badge next to *Settings*.
`pnpm start` runs the server under a small supervisor that restarts it after an update (`pnpm dev` does not – restart by hand).

## CLI

```bash
export COCOON_URL=http://127.0.0.1:7420 COCOON_TOKEN=<token>   # optional: COCOON_LANG=en

pnpm cocoon setup                                  # first-time setup checklist
pnpm cocoon info

# credentials & providers
pnpm cocoon secrets set ANTHROPIC_API_KEY sk-ant-…
pnpm cocoon secrets ls
pnpm cocoon providers add openrouter openai https://openrouter.ai/api/v1 --key sk-or-… --model anthropic/claude-sonnet-4
pnpm cocoon providers test openrouter
pnpm cocoon providers ls | rm <id>

# environment variables (levels: workspace, repository, sandbox) – see "Environment variables"
pnpm cocoon env set --repo https://github.com/you/repo.git DATABASE_URL=postgres://… [--target env|file|both] [--proxy-host api.example.com]
pnpm cocoon env ls --sandbox <sandbox-id> --merged

# sandboxes
pnpm cocoon sandbox create --name demo --repo https://github.com/you/repo.git [--ref main] [--network egress|open|none] [--runtime runsc]
pnpm cocoon sandbox create --name platform --repo https://github.com/acme/api.git=api --repo https://github.com/acme/web.git#develop=web [--service postgres]
pnpm cocoon sandbox ls | get | start | stop | rm <sandbox-id>
pnpm cocoon sandbox exec <sandbox-id> -- npm test
pnpm cocoon sandbox diff <sandbox-id> -o fix.patch [--repo api]
pnpm cocoon sandbox apply <sandbox-id> change.patch [--repo api]
pnpm cocoon repo ls <sandbox-id>
pnpm cocoon repo add <sandbox-id> https://github.com/acme/worker.git [--folder worker] [--ref main]
pnpm cocoon repo rm <sandbox-id> worker

# agents
pnpm cocoon agent spawn <sandbox-id> claude-code -p "Fix the failing tests" [--provider my-gateway] [--model …]
pnpm cocoon agent ls [--sandbox <id>]
pnpm cocoon agent wait <agent-id> [--until done,blocked,exited] [--timeout 300000]
pnpm cocoon agent read <agent-id> -n 100
pnpm cocoon agent send <agent-id> "Also add tests"
pnpm cocoon agent keys <agent-id> Down Enter
pnpm cocoon agent kill <agent-id>
pnpm cocoon attach <agent-id>                      # interactive terminal, detach with Ctrl-b d

# files & git
pnpm cocoon files ls | cat <sandbox-id> <path>
pnpm cocoon files put <sandbox-id> ./local.txt path/in/workspace.txt
pnpm cocoon git status <sandbox-id> [--repo api]                # --repo <folder>: required with several repositories
pnpm cocoon git commit <sandbox-id> "message"
pnpm cocoon git push <sandbox-id> cocoon/fix
pnpm cocoon git pr <sandbox-id> cocoon/fix "Fix tests" [--body …] [--base main]

# workspaces & tasks
pnpm cocoon ws create "Shop" --repo https://github.com/you/shop.git --auto-run --parallel 2 --workflow plan-build-review
pnpm cocoon ws ls | rm <workspace-id> [--delete-sandboxes]
pnpm cocoon task create <workspace-id> "Add dark mode" -d "Details for the agent" [--agent claude-code | --workflow build-review] [--after <task-id>] [--queue | --start]
pnpm cocoon task ls [--workspace <id>]
pnpm cocoon task start | approve | finished | stop | rm <task-id>
pnpm cocoon task reject <task-id> "Please also add tests"
pnpm cocoon schedule create <workspace-id> "Nightly checks" "0 3 * * *" --template checks --tz Europe/Berlin
pnpm cocoon schedule create <workspace-id> "Weekly updates" "0 4 * * 1" --template dependencies [--agent codex] [--always] [--no-auto-close]
pnpm cocoon schedule ls [--workspace <id>]
pnpm cocoon schedule run <schedule-id> [--force]    # run once now
pnpm cocoon schedule pause | resume <schedule-id>
pnpm cocoon schedule rm <schedule-id> [--delete-tasks]
pnpm cocoon schedule preview "*/30 8-18 * * 1-5" --tz Europe/Berlin

# shared services (databases, mocks)
pnpm cocoon services add postgres                  # also: mysql | mongodb | redis | wiremock | mailpit
pnpm cocoon services add postgres --id company-db --external db.internal:5432 --admin-user admin --admin-password … --manual
pnpm cocoon services ls | start | stop | test | credentials <id>
pnpm cocoon services rm <id> [--delete-data]
pnpm cocoon services connections <sandbox-id>
pnpm cocoon services attach | detach | reset <sandbox-id> <service-id>

# ports (servers started in a sandbox)
pnpm cocoon ports ls <sandbox-id>
pnpm cocoon ports open <sandbox-id> 5173 [--shared] [--name web]
pnpm cocoon ports close <sandbox-id> 5173

# updates
pnpm cocoon update                                 # check CoCoon, agent tools and images
pnpm cocoon update apply [cocoon|tools|images]     # update (default: everything outdated) and wait
pnpm cocoon restart

# admin
pnpm cocoon tokens create ci | ls | revoke <id>
pnpm cocoon settings
pnpm cocoon events [--sandbox <id>] [--agent <id>]  # live event stream
pnpm cocoon rpc <method> '<json params>'            # call any API method
```

Add `--json` to any command for machine-readable output.

## MCP integration

CoCoon exposes sandboxes, agents, files and git as MCP tools (Streamable HTTP, stateless), so a "lead" agent can delegate work
to sub-agents in sandboxes:

```bash
claude mcp add --transport http cocoon http://127.0.0.1:7420/mcp --header "Authorization: Bearer <token>"
```

Tools: `system_info`, `sandbox_create/list/get/update/start/stop/delete/exec/diff/apply_patch`, `files_list/read/write/mkdir/delete`,
`git_status/commit/push/create_pr`, `agent_spawn/list/get/send_input/send_keys/read/wait/kill`,
`workspace_list/get/create/update/delete`, `task_list/get/create/update/delete/start/approve/reject/stop` – so a lead agent can
plan work as tasks, let sub-agents run them and review the results.
Admin methods (settings, secrets, tokens, images) are intentionally not available via MCP.

## HTTP & WebSocket API

Every operation is defined once with zod schemas in [`packages/protocol/src/methods.ts`](packages/protocol/src/methods.ts)
and served over all transports. Authenticate with `Authorization: Bearer <token>` (or `?token=` for browser WebSockets/downloads).

```
POST /v1/rpc/<method>                body = params  →  { result } | { error: { code, message, details } }
WS   /v1/ws                          { id, method, params } → { id, result } | { id, error }
                                     "events.subscribe" { types?, sandboxId?, agentId? } → { subscription, event } …
WS   /v1/agents/:id/attach?cols&rows binary frames = terminal bytes; text {"type":"resize","cols","rows"}
GET  /v1/sandboxes/:id/archive?path= tar download of a file or folder
POST /mcp                            MCP endpoint
GET  /healthz                        health check (no auth)
```

| Area | Methods |
|---|---|
| System | `system.info`, `system.setup_status`, `activity.list` |
| Images | `image.status`, `image.build` |
| Environment | `env.get/set/unset/import/resolve/apply` (admin only, not in MCP) |
| Admin | `settings.get/update/reset`, `secrets.list/set/delete`, `tokens.list/create/revoke`, `providers.test`, `notifications.test`, `egress.denied` |
| Workspaces | `workspace.list/get/create/update/delete` |
| Tasks | `task.list/get/create/update/delete/start/approve/reject/stop` |
| Scheduled agents | `schedule.list/get/create/update/delete/run/preview` |
| Cockpit | `layout.get/save` |
| Sandboxes | `sandbox.create/list/get/update/start/stop/delete/exec/diff/apply_patch` |
| Files | `files.list/read/write/mkdir/delete` |
| Git | `git.status/commit/push/create_pr` |
| Agents | `agent.spawn/list/get/send_input/send_keys/read/wait/kill` |
| Events | `sandbox.updated/deleted`, `agent.updated`, `workspace.updated/deleted`, `task.updated/deleted`, `schedule.updated/deleted`, `settings.updated`, `image.build`, `activity` |

Example:

```bash
curl -s -X POST http://127.0.0.1:7420/v1/rpc/agent.spawn \
  -H "Authorization: Bearer $COCOON_TOKEN" -H 'content-type: application/json' -H 'x-cocoon-lang: en' \
  -d '{"sandboxId":"sb_…","kind":"claude-code","prompt":"Write tests for src/utils.ts"}'
```

TypeScript users can use the typed client in [`packages/cli/src/client.ts`](packages/cli/src/client.ts).

## Configuration

Everything is configurable in the UI. Environment variables (all optional, see [.env.example](.env.example)):

| Variable | Default | Purpose |
|---|---|---|
| `COCOON_HOST` | `127.0.0.1` | Listen address |
| `COCOON_PORT` | `7420` | Listen port |
| `COCOON_PUBLIC_URL` | – | Public URL used in the printed login link |
| `COCOON_DATA_DIR` | `<repo>/.data` | State, secrets, admin token, egress policy |
| `COCOON_TOKEN` | – | Additional fixed API token (≥ 16 chars); otherwise an admin token is generated |
| `COCOON_CONFIG` | – | JSON with initial settings for the very first start ([example](cocoon.config.example.json)) |
| `COCOON_DRIVER` | `auto` | Sandbox backend: `auto`, `docker`, `podman`, `bwrap` |
| `COCOON_INSTANCE` | – | Name suffix for this server's Docker resources (network, proxy, services, toolbox) – lets several servers share one Docker host |
| `COCOON_TOOLBOX_AUTOINSTALL` | `1` | `0` skips installing the agent CLIs on first start |
| `COCOON_TOOLBOX_IMAGE` | `docker.io/library/node:24-bookworm-slim` | Docker/Podman: image the agent toolbox is installed with; its Node.js is copied into the toolbox |
| `COCOON_UPDATE_CHECK` | `1` | `0` turns off the daily update check |
| `COCOON_PORTS` | `1` | `0` turns off port forwarding (previews and sharing) |
| `COCOON_PORTS_PREVIEW_RANGE` | `7500-7549` | host ports for previews (published on 127.0.0.1) |
| `COCOON_PORTS_SHARE_RANGE` | `7550-7599` | host ports for shared ports |
| `COCOON_PORTS_SHARE_BIND` | `0.0.0.0` | address shared ports are published on; empty = sharing disabled |
| `COCOON_PREVIEW_DOMAIN` | – | wildcard domain for previews (`p<port>-<sandbox>.<domain>`, HTTPS); default `*.localhost` on the CoCoon port |
| `COCOON_SERVICE_IDLE_MINUTES` | `10` | Minutes without a running sandbox before a managed shared service is paused |
| `DOCKER_SOCKET` | auto-detected | Path to the Docker or Podman API socket |
| `COCOON_PROXY_PORT` | `7431` | bubblewrap only: port of the local egress proxy (credential proxy = port + 1) |
| `LOG_LEVEL` | `info` | Server log level |

Settings sections: `general` (language, onboarding completion), `providers`, `sandbox` (image, default network, resources, runtime, max sandboxes,
workdir), `egress` (allowlist, credential proxy), `agents` (agent types), `status` (poll interval, idle threshold),
`git` (author name/email), `workflows`, `notifications` (webhook URL, events).

## Deployment

- **systemd:** [`deploy/cocoond.service`](deploy/cocoond.service) – run as a dedicated `cocoon` user (in the `docker` group for
  Docker; for rootless Podman enable `podman.socket` for that user and `loginctl enable-linger cocoon`).
- **TLS:** [`deploy/Caddyfile`](deploy/Caddyfile) – reverse proxy with automatic HTTPS in front of `127.0.0.1:7420`
  (WebSockets work out of the box). Alternatively use a VPN (WireGuard/Tailscale) or an SSH tunnel.
- Recommended host: Ubuntu 24.04, ≥ 4 cores, ≥ 8 GB RAM, ≥ 40 GB disk. Back up `.data/`.

## Project structure

```
packages/protocol     Shared zod schemas: models, settings, method registry, events, wire format, cron parser
packages/server       cocoond
  src/main.ts             wiring, first-time setup, startup
  src/http.ts             Fastify: auth, RPC, WebSockets, attach, archive, MCP, web UI, language per request
  src/rpc.ts              method → handler
  src/mcp.ts              MCP server generated from the method registry
  src/i18n.ts             server messages (de/en)
  src/tasks.ts            task orchestration engine (lifecycle, workflows, reviews, auto-run, reports of scheduled runs)
  src/schedules.ts        scheduled agents (cron engine: due runs → tasks, overlap, catch-up, pruning)
  src/workspaces.ts · notifications.ts
  src/settings.ts · secrets.ts · tokens.ts · providers.ts · activity.ts · images.ts · egress.ts · store.ts
  src/sandbox/            driver interface + drivers (docker.ts: Docker/Podman, bwrap.ts: bubblewrap, select.ts: auto-selection),
                          lifecycle/bootstrap, files & git, tar helper
  src/agents/             agent manager, status detection, hooks, tmux helpers
packages/web          Management UI (React 19, Vite, Tailwind CSS v4, TanStack Query, xterm.js; i18n in src/i18n)
packages/cli          `cocoon` CLI + typed API client
site/                 Project website (GitHub Pages, deployed by .github/workflows/pages.yml)
images/sandbox        Sandbox base image (Debian slim: git, tmux, ripgrep; variants "db" + database clients, "full" + compilers, Python)
images/egress-proxy   Allowlist + credential proxy
images/port-gateway   TCP forwarder for previews and shared ports (runs in the egress-proxy image)
deploy/               systemd unit, Caddyfile
docs/                 Beginner's guides (EN/DE), architecture (DE)
```

Requirements for custom sandbox images: `sh`, `git`, `tmux`, a non-root default user and a writable `/workspace`. Node.js comes from
the toolbox; it is a glibc build, so for musl-based images (Alpine) set `COCOON_TOOLBOX_IMAGE` to a matching installer image
(e.g. `node:24-alpine`).

## Development

```bash
pnpm dev            # server in watch mode
pnpm dev:web        # Vite dev server on :5173, proxying the API to :7420
pnpm typecheck      # all packages
pnpm build:web      # production build of the UI (served by cocoond)
pnpm build:image    # build the sandbox image manually (pnpm build:image:db / build:image:full for the other variants)
```


### Tests

```bash
pnpm test               # unit tests (Vitest, no Docker/network, < 1 s)
pnpm test:integration   # integration tests against a real server with Docker (sandboxes, agents, proxy,
                        # API translation, several repositories, shared services, .env injection, every agent CLI
                        # from the toolbox in the slim image; builds the "db" variant for the shared-services test)
```

The integration tests start their own server with `COCOON_INSTANCE=it…` (own port, data folder, Docker network,
proxy and service containers), so they can run next to a live CoCoon on the same host and clean up afterwards
(`COCOON_IT_KEEP=1` keeps the server log). GitHub Actions runs typecheck, unit tests, the web build and the
integration tests on every push and pull request.

## Limitations & roadmap

- Local models: tested with a llama.cpp-based chat-only server; translation covers text, images (Anthropic) and function/custom tool
  calls, not thinking/reasoning blocks or hosted tools. Agent quality depends heavily on the model's tool-calling ability.
- gVisor / Kata runtimes are supported but untested on macOS. Podman was tested via its Docker-compatible API in a nested
  environment (image builds, sandboxes, agents, terminals); its NAT networking (egress proxy, toolbox install) could not be exercised
  there. bubblewrap was tested end to end on Fedora (sandboxes, agents, terminals, egress proxy, toolbox, restart survival).
- Planned: a Firecracker driver for maximum isolation (own kernel per sandbox) and enforced egress for bubblewrap (e.g. via pasta).
- Each cockpit terminal is a separate attach connection; a shared output stream per agent for many viewers is planned.
- Planned: desktop app (Tauri) for the cockpit with native notifications, remote drivers (Vercel Sandbox, E2B), multi-user with
  roles and quotas, SQLite/Postgres instead of the JSON store, sandbox templates/snapshots, conditional workflow branches.

## Support

If CoCoon is useful to you, you can support its development:

<a href="https://www.buymeacoffee.com/adziendziolD"><img src="https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20Coffee&emoji=%E2%98%95&slug=adziendziolD&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff" alt="Buy me a coffee" height="42" /></a>

## License

[MIT](LICENSE) © 2026 Alexander Dziendziol-Dickopf

CoCoon installs third-party tools (e.g. Claude Code, OpenAI Codex, Node.js and Debian packages) into images and the agent toolbox;
they are not part of this repository and are subject to their own licenses and terms of use.
