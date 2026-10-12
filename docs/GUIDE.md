# CoCoon – Beginner's guide

This guide gets CoCoon running on your own server (e.g. a rented Linux server from Hetzner, DigitalOcean, …) and walks you
through the first steps in the web interface. No programming knowledge needed – just copy a few commands.
*(Deutsche Version: [ANLEITUNG.md](ANLEITUNG.md))*

## What is CoCoon?

CoCoon is a "workshop" for AI coding agents like Claude Code or OpenAI Codex. Every agent works in its own isolated
**sandbox** – a small, sealed-off computer inside your computer. An agent can't break anything on your server, and you decide
what it may do (e.g. which websites it can reach). The web interface shows live what your agents are doing and lets you give them tasks.

## 1. Prepare the server (once)

Recommended: Ubuntu 24.04, at least 4 CPU cores, 8 GB RAM, 40 GB disk. Connect via SSH and run:

CoCoon needs one "sandbox technology". Pick **one** of these (Docker is the most common, Podman runs without root,
bubblewrap is the lightest):

```bash
# Option A – Docker
curl -fsSL https://get.docker.com | sh
# Option B – Podman (no background service, no root):  sudo apt install -y podman
#            then, as the cocoon user: systemctl --user enable --now podman.socket
# Option C – bubblewrap (very lightweight, no images): sudo apt install -y bubblewrap tmux git

# Install Node.js 24 and pnpm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pnpm

# Create a dedicated user for cocoon (allowed to use Docker)
sudo useradd --system --create-home --groups docker cocoon
```

## 2. Install CoCoon

```bash
sudo -u cocoon -i
git clone <url-of-this-repository> cocoon && cd cocoon
pnpm setup
pnpm start
```

On first start the console shows a line like:

```
  CoCoon is running: http://127.0.0.1:7420
  Log in: http://127.0.0.1:7420/?token=cct_…
```

The token is also stored in `.data/admin-token.txt`. In the background CoCoon now sets everything up automatically
(network protection, sandbox image) – the first time this can take a few minutes.
Tip: the default language for console and CLI messages is English; change it under *Settings → General*.

## 3. Access it from your computer

For security, CoCoon only listens on the server itself. The easiest secure way from your laptop is an **SSH tunnel**:

```bash
ssh -L 7420:127.0.0.1:7420 user@your-server
```

While that window is open, open the login link from step 2 in your browser.
For permanent access with your own domain and HTTPS, install [Caddy](https://caddyserver.com) and use `deploy/Caddyfile`,
or use a VPN such as [Tailscale](https://tailscale.com).

## 4. First steps in the web interface

After the first login the **setup wizard** opens automatically and walks you through everything below step by step – just follow
it. You can restart it anytime under *Settings → General*. What it covers:

1. **Sandbox image** – built automatically; otherwise click "Build".
2. **Credentials** – under *Settings → Credentials* enter your Anthropic API key (for Claude Code) or OpenAI API key (for Codex),
   or add your own endpoint under *Settings → API providers*. Keys stay on the server; in the default network mode agents never even see them.
3. **Create a sandbox** – give it a name, optionally paste a GitHub repository URL, keep internet access at "Restricted (recommended)".
4. **Start an agent** – in the sandbox click "Start agent", e.g. *Claude Code*, and describe the task.
5. The **agent page** shows its terminal live. When the agent has a question (yellow "waiting for your decision" banner),
   answer with one click.
6. **Changes** shows what the agent changed – download it, push it to GitHub or open a pull request (add a GitHub token under Credentials).

## 5. Keep it running

To start CoCoon automatically after a reboot: copy `deploy/cocoond.service` (adjust paths) to `/etc/systemd/system/` and run
`sudo systemctl enable --now cocoond`.

## FAQ

**An agent can't reach the internet / an installation fails.**
In "Restricted" mode only allowed sites are reachable. *Settings → Network & security* lists blocked connections – allow them with one click.

**Can I use my own API or a different model?**
Yes – under *Settings → API providers* add e.g. your company gateway, OpenRouter, a local Ollama or any HTTP API (templates included),
enter the key and click "Test connection". Then assign the provider to an agent type or pick it when starting an agent. The key stays on the server.

**I lost the login token.**
It's in `.data/admin-token.txt` on the server. Create more tokens (e.g. for the CLI) under *Settings → Access & integrations*.

**Can I control CoCoon from Claude Code?**
Yes – *Settings → Access & integrations* shows the ready-made command to add CoCoon as an MCP server.
