# Security Policy

## Reporting a vulnerability

Please report security issues privately and not in a public issue or pull request.

Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/adziendziolD/cocoon/security/advisories/new)
(Security tab → "Report a vulnerability"). Only the maintainer sees the report.

Helpful details: the affected version or commit, steps to reproduce, the impact you expect, and whether the issue is already public.

You can expect an acknowledgement within 7 days. After that, the report is triaged and you are kept informed about the fix
and the planned disclosure. Fixes are released first, then the advisory is published and you are credited if you wish.

## Supported versions

CoCoon is in active development (0.x). Only the latest release and the `main` branch receive security fixes.
Please update before reporting an issue that may already be fixed.

| Version         | Supported |
| --------------- | --------- |
| latest release  | yes       |
| `main`          | yes       |
| older releases  | no        |

## Scope

In scope: the CoCoon server (`cocoond`), the web UI, the CLI, the API and MCP server, the sandbox and egress/credential proxy images,
and the deployment files in `deploy/`.

Out of scope: vulnerabilities in the agent CLIs that run inside sandboxes (Claude Code, Codex, …), in Docker or Podman themselves,
or in a deployment that exposes CoCoon to the internet without the authentication and TLS setup described in the README.
