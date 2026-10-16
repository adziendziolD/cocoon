# CoCoon – Server-Konzept

> Self-hosted Infrastruktur, um Coding-Agenten (Claude Code, Codex, Shell, …) in isolierten
> Sandboxes auf einem Server laufen zu lassen und sie von außen zu steuern.
> Vorbild: [herdr](https://vercel.com/docs/sandbox/ecosystem/herdr) – Terminal-Multiplexer für Agenten
> mit Socket-API, Agent-Status-Erkennung und Sandbox-Plugins.

## 1. Ziele

| Ziel | Umsetzung |
|---|---|
| Agenten laufen isoliert | Jede Sandbox = eigener gehärteter Container; optional gVisor (`runsc`) oder Kata/Firecracker-microVM (`kata-fc`) |
| Agenten überleben Disconnects/Restarts | Agent-Prozesse laufen in **tmux im Sandbox-Container**, nicht im Control-Plane-Prozess |
| Von außen steuerbar | Web-Oberfläche, HTTP-RPC, WebSocket (RPC + Events), Terminal-Attach, MCP-Server, CLI – alles mit Token-Auth |
| Einsteigerfreundlich | Ersteinrichtung automatisch (Admin-Token, Netzwerk, Proxy, Image), alles in der UI konfigurierbar |
| Agenten-agnostisch | Agent = beliebige CLI mit TTY; Verhalten über **Profile** konfigurierbar |
| Maschinenlesbar | Jede Operation liefert JSON → auch andere Agenten/Skripte können orchestrieren |
| Ergebnisse kontrolliert zurückholen | Workspace-Änderungen nur als **Git-Patch** gegen eine Baseline (`sandbox.diff`) |

## 2. Überblick

```
  Browser (Management-UI)   CLI / Skripte   Claude Code & Co. (MCP)
            │                     │                   │
            └──────────── HTTPS (Reverse-Proxy) ──────┘
                                  │
 ┌────────────────────────────────▼──────────────────────────────────────────────────────┐
 │ cocoond  (127.0.0.1:7420)                                                             │
 │   /            Web-UI (packages/web/dist)                                             │
 │   /v1/rpc/:m   /v1/ws (RPC + Events)   /v1/agents/:id/attach (TTY)   /mcp (MCP-Tools)  │
 │   /v1/sandboxes/:id/archive (Download)                                                │
 │                                                                                       │
 │   RPC-Registry (packages/protocol) ─► SandboxManager · WorkspaceService · AgentManager │
 │   SettingsService · SecretsService · TokenService · ImageService · EgressManager       │
 │   ActivityLog · EventBus · Store (.data/state.json, 0600)                              │
 └───────────┬───────────────────────────────────────────────────────────────┬───────────┘
             │ Docker API                                                    │ policy.json
             ▼                                                               ▼
  ┌─ Netz „cocoon-internal“ (internal, kein Internet) ─────────┐   ┌──────────────────────┐
  │  sandbox sb_… (network=egress)                             │   │ cocoon-egress-proxy  │
  │   tmux -L cocoon ─ ag_… claude  ─ ag_… bash                │──►│ :3128 Allowlist-Proxy├──► Internet
  │   /workspace (git, Baseline-Tag)   /opt/cocoon (Hooks)     │   │ :8080 Credential-Prx │   (nur erlaubte
  └────────────────────────────────────────────────────────────┘   └──────────────────────┘    Domains)
     sandbox (network=open) ─► bridge ─► Internet      sandbox (network=none) ─► kein Netz
```

## 3. Begriffe

- **Sandbox** – isolierte Umgebung (Container) mit `/workspace` als Git-Repo (geklont oder leer) und Baseline-Tag
  `cocoon-baseline`. Lebenszyklus: `creating → running ⇄ stopped`, `error`, `missing`.
- **Agent** – ein Prozess (CLI) in einer tmux-Session innerhalb einer Sandbox. Mehrere Agenten pro Sandbox möglich.
- **Agent-Typ / Profil** – wie ein Agent gestartet wird (`command`, `promptMode`), welche Secrets er bekommt, ob Status-Hooks
  installiert werden und wie der Bildschirm interpretiert wird. Standard: `claude-code`, `codex`, `shell`; in der UI editierbar.
- **Settings** – zur Laufzeit änderbare Konfiguration (Sandbox-Standards, Netzwerk-Allowlist, Profile, Zeiten, Git-Autor),
  gespeichert im Store. `COCOON_CONFIG` dient nur als Startwert beim allerersten Start.
- **Geplanter Agent (Schedule)** – Cron-Ausdruck (5 Felder, IANA-Zeitzone) + Anweisungen in einem Workspace. Zu jedem Termin
  legt `ScheduleService` eine Aufgabe (`task.scheduleId`) an und startet sie sofort. Der letzte Agent des Laufs schreibt einen
  Bericht (`<workdir>/.cocoon/report/<taskId>.json`, Pfad auch in `$COCOON_REPORT_FILE`): `ok` + `autoClose` → Aufgabe erledigt,
  eigene Sandbox entfernt; sonst `review` mit Benachrichtigung. `overlap: skip` startet nichts, solange ein Lauf offen ist;
  verpasste Termine werden beim Start einmal nachgeholt; ältere abgeschlossene Läufe werden samt Sandbox aufgeräumt (`keepRuns`).
- **Secrets** – API-Keys/Tokens, serverseitig gespeichert (Fallback: Umgebungsvariablen), nie im Klartext an Clients zurück.

## 4. Agent-Status

| Status | Bedeutung |
|---|---|
| `working` | arbeitet |
| `blocked` | wartet auf eine menschliche Entscheidung (Berechtigungsabfrage, y/n …) |
| `done` | hat die Aufgabe abgeschlossen |
| `idle` | wartet, keine offene Aufgabe |
| `exited` | Prozess beendet (Exit-Code) |
| `unknown` | nicht ermittelbar |

**Zwei Quellen** (Feld `statusSource`):
1. **Hooks** (`hook`): Beim Erstellen einer Sandbox werden native Hooks installiert, die `/opt/cocoon/bin/cocoon-status <status>` aufrufen:
   Claude Code über `~/.claude/settings.json` (`UserPromptSubmit`/`PreToolUse`/`PostToolUse` → working, `Notification[permission_prompt]` → blocked,
   `Stop` → done), Codex über `notify` in `~/.codex/config.toml` (→ done). Das Skript schreibt in `/opt/cocoon/status/<agentId>` –
   **kein Netzwerkzugriff zur Control-Plane nötig**.
2. **Heuristik** (`heuristic`): Bildschirm ändert sich → working; ruhig + Blocked-Pattern → blocked; ruhig nach Aufgabe → done;
   bei Shell-Agenten zählt ein laufender Vordergrundprozess als working.

Hook-Meldungen gewinnen; nach neuer Eingabe zählen erst neue Meldungen. Meldet ein Hook „working“, der Bildschirm ist aber
15 s ruhig ohne Arbeitsanzeige (z. B. API-Fehler ohne `Stop`-Hook), übernimmt die Heuristik. Ein Poller macht **einen** `exec` pro Sandbox
und Tick (Status-Datei, tmux-Zustand, Vordergrundprozess, Bildschirm).

Claude Codes Onboarding-, Theme- und Trust-Dialoge werden per `~/.claude.json` übersprungen; API-Keys werden vorab bestätigt.

## 5. API

Alle Methoden stehen in `packages/protocol/src/methods.ts` (zod-Schemas + Beschreibung) und werden identisch über HTTP,
WebSocket und – soweit als agentenseitig markiert – MCP angeboten.

```
POST /v1/rpc/<method>     body = params          → { result } | { error: { code, message, details } }
WS   /v1/ws               { id, method, params } → { id, result } | { id, error }
                          "events.subscribe" { types?, sandboxId?, agentId? } → { subscription, event }…
WS   /v1/agents/:id/attach?cols&rows   Binary = Terminal-Bytes, Text-JSON {type:"resize",cols,rows}
GET  /v1/sandboxes/:id/archive?path=   Tar-Download
POST /mcp                 MCP Streamable HTTP (stateless), Tools = API-Methoden (sandbox_create, agent_spawn, …)
GET  /healthz             ohne Auth
```
Auth: `Authorization: Bearer <token>` oder `?token=` (für Browser-WebSockets/Downloads).

| Bereich | Methoden |
|---|---|
| System | `system.info`, `system.setup_status`, `activity.list` |
| Images | `image.status`, `image.build` (Fortschritt als `image.build`-Events) |
| Verwaltung | `settings.get/update/reset`, `secrets.list/set/delete`, `tokens.list/create/revoke`, `providers.test`, `egress.denied` |
| Sandbox | `sandbox.create/list/get/start/stop/delete/exec/diff/apply_patch` |
| Dateien | `files.list/read/write/mkdir/delete` |
| Git | `git.status/commit/push/create_pr` (GitHub, via `GITHUB_TOKEN`) |
| Agent | `agent.spawn/list/get/send_input/send_keys/read/wait/kill` |
| Geplante Agenten | `schedule.list/get/create/update/delete/run/preview` |
| Events (WS) | `sandbox.updated/deleted`, `agent.updated`, `schedule.updated/deleted`, `settings.updated`, `image.build`, `activity` |

Admin-Methoden (Settings, Secrets, Tokens, Images) sind **nicht** als MCP-Tools verfügbar – ein steuernder Agent kann Sandboxes und
Agenten bedienen, aber keine Keys auslesen oder Sicherheitseinstellungen ändern.

## 6. Netzwerk & Secrets

| Modus | Umsetzung |
|---|---|
| `none` | Docker `NetworkMode: none` |
| `egress` (Standard) | Sandbox hängt nur im `internal`-Netz `cocoon-internal` (kein Gateway, kein DNS nach außen). Einziger Weg nach draußen ist der Egress-Proxy (`HTTP(S)_PROXY` ist gesetzt): nur Domains der Allowlist, nur Ports 80/443, nur bekannte Sandbox-IPs. Blockierte Versuche landen in `egress.denied` → in der UI mit einem Klick erlaubbar. |
| `open` | Docker-Bridge, freies Internet |

**Credential-Proxy** (`egress.credentialProxy`, Standard an): Im egress-Modus bekommen Agenten für `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` nur einen Platzhalter `cocoon_<sandboxToken>_<NAME>` und `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` zeigt auf den Proxy.
Der Proxy tauscht den Platzhalter gegen den echten Key und leitet per TLS weiter. **Der echte Key gelangt nie in die Sandbox**
(getestet: weder in Env, Dateien noch `/proc`). Andere Secrets (z. B. `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`) werden direkt injiziert.

Der Proxy läuft als eigener Container (`images/egress-proxy`, ohne Abhängigkeiten), read-only, ohne Capabilities, mit der UID von cocoond.
cocoond schreibt `.data/egress/policy.json`; der Proxy lädt Änderungen sofort und bestätigt die Version (`ack`) – das Klonen eines Repos
beginnt erst, wenn der Proxy die neue Sandbox kennt.

Git-Zugangsdaten für GitHub werden nur pro Befehl als `GIT_CONFIG_*`-Variablen übergeben, nie in die Git-Konfiguration geschrieben.

### Eigene API-Anbieter (`settings.providers`)

Agenten können statt (oder zusätzlich zu) den Standard-Keys eigene Endpunkte nutzen. Ein Anbieter hat `kind`, `baseUrl`,
den Namen eines Secrets mit dem Key, die Art der Authentifizierung (`bearer`, `x-api-key`, eigener Header, keine) sowie Modelle.
Agent-Typen (`providers`, `model`) oder einzelne Starts (`agent.spawn { providers, model }`) wählen Anbieter aus.

| Typ | Der Agent bekommt | Typische Ziele |
|---|---|---|
| `anthropic` | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` bzw. `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` | Firmen-Gateway, LiteLLM, DeepSeek, Bedrock-Proxy – für Claude Code |
| `openai` | `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (+ `--model` für Codex) | OpenRouter, Groq, Mistral, Ollama, vLLM |
| `http` | `<PREFIX>_BASE_URL`, `<PREFIX>_API_KEY` | beliebige (interne) REST-APIs |

Im egress-Modus zeigt die Base-URL auf den Credential-Proxy (`http://cocoon-proxy:8080/p-<id>`); der Proxy **setzt den Auth-Header
selbst** und tauscht Platzhalter – der echte Key bleibt auf dem Server. Eine Sandbox darf eine Route erst nutzen, wenn darin ein Agent
mit diesem Anbieter gestartet wurde (Grants pro Sandbox). `localhost` in der Base-URL wird automatisch zu `host.docker.internal`, sodass
Dienste auf dem Server selbst (z. B. Ollama) erreichbar sind. Anbieter-Hosts werden automatisch zur Allowlist hinzugefügt.
`providers.test` prüft Erreichbarkeit, Anmeldung und liest die Modellliste – direkt vom Server, auch vor dem Speichern.

### Mehrsprachigkeit

Die Weboberfläche gibt es auf Deutsch und Englisch (folgt der Browsersprache, Fallback Englisch; Umschalter in der Seitenleiste, die Wahl wird im Browser gespeichert).
Der Server übersetzt Fehlermeldungen, Aktivitätsprotokoll und Setup-Checkliste in die Sprache der Anfrage:
Header `x-cocoon-lang` bzw. `?lang=` → `Accept-Language` → `settings.general.language` (Standard für CLI/API).
Aktivitätseinträge werden als Schlüssel + Parameter gespeichert und pro Client gerendert.

### Sandbox-Techniken (Driver)

Der Server spricht Sandboxes nur über `SandboxDriver` an. Implementiert sind:

| Driver | Umsetzung | Fähigkeiten |
|---|---|---|
| `docker` | Docker Engine API | Images, Ressourcenlimits, erzwungener Egress, Runtimes (gVisor, Kata) |
| `podman` | Podman über die Docker-kompatible API (rootless, ohne Daemon); Host-Alias `host.containers.internal`, Proxy-Container als Container-root (= Benutzer) | wie Docker, zusätzlich z. B. `krun` |
| `bwrap` | bubblewrap: Sandbox = Ordner unter `.data/sandboxes/<id>`, Host-System schreibgeschützt, eigene User/PID/IPC/UTS-(Netz-)Namespaces, keine Capabilities, tmux-„Keeper“ pro Sandbox, Egress-Proxy als lokaler Prozess, PTY über node-pty, Optionen per `--args FD` (nicht in `ps` sichtbar) | keine Images, keine Ressourcenlimits, Egress nur konfiguriert (nicht erzwungen) |

Auswahl über `COCOON_DRIVER` (`auto`: Podman-Socket → Docker → bubblewrap). `system.info` liefert `driverKind` und `capabilities`,
die UI blendet nicht verfügbare Optionen aus bzw. weist auf Einschränkungen hin.

**Werkzeugkiste:** Agent-CLIs (Claude Code, Codex, …) samt Node.js-Laufzeit werden einmal in ein Volume (`cocoon-agents`) bzw.
`.data/agents` installiert und schreibgeschützt unter `/opt/agents` eingehängt – das Basis-Image (Debian slim, ohne Node.js) bleibt
unter 250 MB (Variante `db` mit Datenbank-Clients, `full` zusätzlich mit Compilern/Python), Updates brauchen keinen Image-Neubau. **Agent-Secrets** gehen über eine private Env-Datei (0600), die der Agent-Start einliest und
löscht – nie über Kommandozeilen.

## 7. Sicherheit

**Control Plane**
- Bindet standardmäßig nur an `127.0.0.1`; von außen nur über TLS-Reverse-Proxy (`deploy/Caddyfile`) oder VPN (WireGuard/Tailscale).
- Tokens: Beim ersten Start wird ein Admin-Token erzeugt (`.data/admin-token.txt`); weitere Tokens in der UI. Gespeichert werden nur
  SHA-256-Hashes; Vergleich timing-safe. Optional zusätzlich `COCOON_TOKEN` aus der Umgebung.
- `.data/state.json` enthält Secrets → Datei 0600, Verzeichnis 0700. Für höhere Ansprüche: Festplattenverschlüsselung / Secret-Manager.
- cocoond braucht den Docker-Socket ⇒ root-äquivalent. Eigener System-User, Host nur für CoCoon nutzen.

**Sandboxes**
- Non-root-User, `CapDrop: ALL`, `no-new-privileges`, Limits für CPU/RAM/PIDs, `/tmp` als tmpfs, Init-Prozess.
- Runtimes: `runsc` (gVisor, eigener User-Space-Kernel) oder `kata-fc` (Kata Containers mit Firecracker → echte microVM) –
  müssen auf dem Host installiert und in Docker registriert sein; die UI zeigt nur verfügbare Runtimes an.
- Änderungen verlassen die Sandbox nur kontrolliert: Patch (`sandbox.diff`), Download, oder Push auf einen Branch + PR.

## 8. Persistenz & Robustheit

- Store wird atomar geschrieben; `reconcile()` gleicht beim Start mit Docker ab (Status, IPs).
- Container: `RestartPolicy: unless-stopped`; Agenten in tmux ⇒ ein Neustart von cocoond beendet keine Agenten.
- Stoppen einer Sandbox / Host-Reboot beendet tmux und damit laufende Agenten (→ `exited`); Dateien bleiben erhalten.
- Ersteinrichtung im Hintergrund: internes Netz + Proxy (Image wird bei Bedarf gebaut), Sandbox-Image wird beim ersten Start automatisch gebaut.

## 9. Code-Struktur

```
packages/protocol   zod-Schemas: Modelle, Settings, Methoden-Registry, Events, Wire-Format, Cron-Parser
packages/server     cocoond
  src/main.ts               Wiring, Ersteinrichtung, Start
  src/http.ts               Fastify: Auth, /v1/rpc, /v1/ws, Attach, Archive, /mcp, Web-UI
  src/rpc.ts                Methode → Handler (+ Setup-Checkliste)
  src/mcp.ts                MCP-Server (Tools aus der Registry generiert)
  src/settings.ts · secrets.ts · tokens.ts · providers.ts · activity.ts · images.ts · egress.ts · store.ts
  src/i18n.ts               Server-Texte (de/en), Sprache pro Anfrage
  src/sandbox/driver.ts     SandboxDriver-Interface
  src/sandbox/docker.ts     Docker-Implementierung (Netzmodi, Runtimes, exec, TTY, Archive)
  src/sandbox/manager.ts    Lebenszyklus, Bootstrap (/opt/cocoon, Hooks, Git-Baseline, Clone)
  src/sandbox/workspace.ts  Dateien, Patches, Git, Pull Requests
  src/agents/manager.ts     Spawn (Secrets/Credential-Proxy), Input, Read, Wait, Kill, Status-Poller
  src/agents/status.ts      Statuserkennung (Hooks + Heuristik)
  src/agents/hooks.ts       Hook-Konfiguration für Claude Code / Codex
  src/agents/tmux.ts        tmux-Kommandos und Snapshot-Parser
  src/tasks.ts              Aufgaben-Engine (Lebenszyklus, Workflows, Reviews, Auto-Run, Berichte geplanter Läufe)
  src/schedules.ts          Geplante Agenten (fällige Termine → Aufgaben, Überlappung, Nachholen, Aufräumen)
packages/web        Management-UI (React, Vite, Tailwind, xterm.js)
packages/cli        cocoon – Remote-CLI + typisierter Client
images/sandbox      Basis-Image (Node, Git, tmux, Claude Code, Codex)
images/egress-proxy Allowlist- und Credential-Proxy
deploy/             systemd-Unit, Caddyfile
```

## 10. Roadmap

Erledigt: Status-Hooks, Egress-Proxy mit Allowlist, Credential-Proxy, Dateien/Patches/Push/PR, Runtime-Auswahl (gVisor, Kata/Firecracker),
Management-UI mit Browser-Terminal, MCP-Server, Settings/Secrets/Tokens in der UI, automatische Ersteinrichtung,
Mehrsprachigkeit (de/en), eigene API-Anbieter.

Offen:
1. **Remote-Driver** (Vercel Sandbox, E2B) als weitere `SandboxDriver`-Implementierung.
2. **Multi-User**: Benutzer/Rollen, Token-Scopes, Quotas, Audit-Log; SQLite/Postgres statt JSON-Store.
3. **Credential-Proxy für weitere Dienste** (GitHub, OAuth-Token) und kurzlebige Tokens.
4. **Templates/Snapshots** für schnellen Sandbox-Start; persistente Volumes.
5. **Benachrichtigungen** (E-Mail/Slack/Push), wenn ein Agent blockiert oder fertig ist.
