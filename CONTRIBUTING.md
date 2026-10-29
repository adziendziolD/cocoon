# Contributing to CoCoon

Thanks for wanting to help. Bug reports, fixes, documentation and ideas are all welcome. This page explains how to get a change into `main` with as little back and forth as possible.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if you are not sure it is a bug.
- **Features and larger changes:** open an issue first and describe the problem you want to solve. That avoids work on something that does not fit the project (see the roadmap at the end of the [README](README.md)).
- **Security problems:** do not open a public issue or pull request. Report them privately as described in [SECURITY.md](SECURITY.md).
- Look through the [open issues](https://github.com/adziendziolD/cocoon/issues) first; your topic may already be tracked.

## Setting up

You need Node.js 24 or newer, [pnpm](https://pnpm.io) (the version is pinned in `package.json`, `corepack enable` picks it up) and, for the integration tests and for running sandboxes, Docker or Podman.

```bash
git clone https://github.com/adziendziolD/cocoon.git
cd cocoon
pnpm install
pnpm dev            # server in watch mode
pnpm dev:web        # Vite dev server for the UI (proxies the API)
```

The repository is a pnpm workspace:

| Path | Content |
|---|---|
| `packages/protocol` | shared types, Zod schemas and API methods (the single source for server, CLI and web) |
| `packages/server` | `cocoond`, the control plane |
| `packages/web` | the management UI (React, Vite, Tailwind) |
| `packages/cli` | the `cocoon` command line |
| `images/` | sandbox base image, egress proxy, port gateway |
| `tests/integration` | integration tests against a real server and Docker |

The [README](README.md#project-structure) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) go into more detail.

## Making a change

1. Fork the repository (or create a branch if you have write access) and branch off `main`. Branch names use a prefix: `fix/…`, `feature/…`, `docs/…` or `chore/…`.
2. Keep one concern per pull request. A bug fix and an unrelated refactoring are two pull requests.
3. Run the checks below before you push.
4. Open a pull request against `main`. Describe what changes and why, mention how you tested it, and link the issue (`Closes #123`).

`main` is protected: every change goes through a pull request, the check **Typecheck, unit tests, web build** has to pass, and stale reviews are dismissed when you push again. Pull requests are normally squash-merged, so the pull request title becomes the commit message: short, in the imperative ("Fix task race when stopping and starting again").

### Checks to run locally

```bash
pnpm typecheck          # all packages
pnpm test               # unit tests (Vitest, no Docker or network, takes seconds)
pnpm build:web          # when you touched the UI
pnpm test:integration   # when you touched sandboxes, agents, proxies, services or tasks (needs Docker)
```

GitHub Actions runs the same checks on every pull request, plus the sandbox image builds, the integration tests and CodeQL. The integration tests start their own server with their own port, data folder and containers, so they can run next to a live CoCoon on the same machine.

## Tests

- A bug fix comes with a test that fails without the fix. Say so in the pull request if that is not possible.
- New behaviour gets unit tests next to the code (`*.test.ts`). Use an integration test in `tests/integration` where the behaviour depends on real containers.
- The UI package (`packages/web`) has no unit tests yet. For UI changes, describe what you checked by hand and add a screenshot if the change is visible.

## Code style

- Match the code around your change: naming, comment density and idiom. Formatting follows [`.editorconfig`](.editorconfig) (2 spaces, LF, final newline).
- TypeScript everywhere. Types and schemas that cross the API boundary live in `packages/protocol`.
- Comments explain why, not what.
- Code, comments, commit messages and issues are in English. User-visible texts exist in German and English: add both (server messages in `packages/server/src/i18n.ts`, UI texts in `packages/web/src/i18n`).
- Do not commit secrets, tokens, `.env` files or the `.data/` folder.

## Security-sensitive code

CoCoon runs untrusted agents, so some areas need extra care. If you change one of them, explain the reasoning in the pull request.

- **Sandboxes, egress proxy, credential proxy, port gateway:** anything that widens what a sandbox can reach or see.
- **Untrusted input** (API parameters, repository URLs, files an agent wrote): avoid regular expressions that backtrack on long runs of one character, such as `/\/+$/` or `/\s*```$/`. Use the helpers in `packages/protocol/src/strings.ts` or plain string functions.
- **Shell, SQL and URLs built from names:** quote or validate them (see `mysqlIdent` and `parseGithubRepo` for examples).
- **Authentication and tokens:** compare in constant time, never log them.

## Dependencies and workflows

- New dependencies need a reason in the pull request. Prefer the standard library or what is already in the lockfile. Commit `pnpm-lock.yaml` with the change.
- [Dependabot](.github/dependabot.yml) opens update pull requests for npm packages, Docker base images and GitHub Actions. Review them like any other change.
- Every `uses:` in `.github/workflows` is pinned to a full commit SHA with the version as a comment, and each workflow declares least-privilege `permissions`. Keep it that way.

## Commits and pull requests

- Write the subject in the imperative and under about 72 characters, then add a body that explains the reason when it is not obvious.
- Do not mix formatting changes with functional changes.
- Respond to review comments by pushing to the same branch; do not open a new pull request.
- AI-assisted contributions are fine. You are responsible for what you submit: read it, run it, and test it. Please mention in the pull request if a large part was generated.

## Reporting bugs

Please include:

- the CoCoon version (`cocoon info` prints it) and how you run it (`pnpm start`, systemd, …),
- the sandbox driver (Docker, Podman, bubblewrap) and the operating system,
- the steps to reproduce, what you expected and what happened,
- relevant log lines. Remove tokens, passwords and API keys first.

## License

By contributing you agree that your contribution is released under the project's [MIT License](LICENSE). There is no contributor license agreement to sign.

## Being a good neighbour

Be respectful and constructive in issues and pull requests. Assume good intent, criticise the code and not the person, and keep discussions about the project.
