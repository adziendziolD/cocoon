import { z } from 'zod';
import { cronError, isValidTimeZone } from './cron.ts';
import { stripCodeFence } from './strings.ts';
import type { LocalizedText } from './models.ts';
import { TaskPriority, type TaskReport } from './orchestration.ts';

/** What a scheduled agent does; "custom" is a free prompt. The others prefill the prompt (it stays editable). */
export const ScheduleTemplate = z.enum(['checks', 'dependencies', 'security', 'custom']);
export type ScheduleTemplate = z.infer<typeof ScheduleTemplate>;

/**
 * When it is time again but the previous run is still open: "skip" waits until it is finished (queued, running or
 * waiting for your review count as open), "always" starts another run anyway.
 */
export const ScheduleOverlap = z.enum(['skip', 'always']);
export type ScheduleOverlap = z.infer<typeof ScheduleOverlap>;

export const ScheduleRunResult = z.enum(['started', 'skipped', 'error']);
export type ScheduleRunResult = z.infer<typeof ScheduleRunResult>;

export const CronExpression = z
  .string()
  .min(1)
  .max(200)
  .superRefine((value, ctx) => {
    const error = cronError(value);
    if (error) ctx.addIssue({ code: 'custom', message: `invalid cron expression: ${error}` });
  });

export const TimeZone = z
  .string()
  .max(100)
  .refine((value) => isValidTimeZone(value), { message: 'unknown time zone (use an IANA name such as Europe/Berlin)' });

/**
 * A scheduled agent: on every run (cron expression in a time zone) it creates a task in its workspace and starts it
 * right away. Tasks go through the normal task lifecycle; the agent leaves a report, and runs whose report says
 * "ok" are closed automatically (autoClose), so only findings reach you.
 */
export const Schedule = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  cron: CronExpression,
  /** IANA time zone, e.g. Europe/Berlin (default: the server's). */
  timezone: TimeZone.optional(),
  template: ScheduleTemplate.default('custom'),
  /** Instructions for the agent (becomes the task description). */
  prompt: z.string().min(1).max(20_000),
  /** Single agent; ignored when workflowId is set. Default: the workspace's default agent type. */
  agentKind: z.string().optional(),
  workflowId: z.string().optional(),
  providers: z.array(z.string()).optional(),
  model: z.string().optional(),
  priority: TaskPriority.default('normal'),
  overlap: ScheduleOverlap.default('skip'),
  /** Runs whose report says "ok" are marked done and their own sandbox is removed – no review needed. */
  autoClose: z.boolean().default(true),
  /** Finished runs (done/failed) kept on the board; older ones are deleted together with their own sandbox. */
  keepRuns: z.number().int().min(1).max(100).default(10),
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastResult: ScheduleRunResult.optional(),
  /** Why the last run was skipped or could not start. */
  lastNote: z.string().optional(),
  lastTaskId: z.string().optional(),
  runCount: z.number().int().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;

const COMMON_DISCOVERY = `Find out how this project is built and checked: package.json scripts, Makefile/justfile/Taskfile, the CI configuration (.github/workflows, .gitlab-ci.yml, …), pyproject.toml/tox.ini/noxfile.py, Cargo.toml, go.mod, composer.json, Gemfile, build.gradle/pom.xml, .pre-commit-config.yaml and the README. With several repositories, do this in every repository folder.`;

/** Prefilled prompts of the templates (English: they are instructions for the agent). */
export const SCHEDULE_TEMPLATES: Record<Exclude<ScheduleTemplate, 'custom'>, { name: LocalizedText; cron: string; prompt: string }> = {
  checks: {
    name: { de: 'Alle Checks ausführen', en: 'Run all checks' },
    cron: '0 3 * * *',
    prompt: `Run every quality check this project has and report the results. Do not change any code.

1. ${COMMON_DISCOVERY}
2. Install the dependencies the way the project does it (lockfile, frozen/CI mode).
3. Run every check you found – prefer the exact commands the CI uses: formatting check, linting, type checking, unit tests, integration/end-to-end tests (if they can run here), the build, and a dependency audit for known vulnerabilities. If a check needs a service (database, …), use the connection from the environment variables; if that is not possible, mark the check as skipped and say why.
4. Do not stop at the first failure – run all checks.
5. For every failure: find the cause (first error, file and line) and suggest a fix in one or two sentences.`,
  },
  dependencies: {
    name: { de: 'Abhängigkeiten aktualisieren', en: 'Update dependencies' },
    cron: '0 4 * * 1',
    prompt: `Check whether the frameworks, libraries and tools of this project need updates, and update what is safe.

1. ${COMMON_DISCOVERY} Find every dependency manifest: npm/pnpm/yarn, pip/poetry/uv, cargo, go modules, composer, bundler, maven/gradle, Docker base images, GitHub Actions versions and runtime versions (.nvmrc, .tool-versions, engines).
2. List outdated dependencies (current → latest), e.g. with \`pnpm outdated\`, \`npm outdated\`, \`pip list --outdated\`, \`go list -m -u all\`, and known vulnerabilities (\`npm audit\`, \`pip-audit\`, \`cargo audit\`, \`govulncheck\`, …) – whatever is available.
3. Apply patch and minor updates and security fixes with the project's own package manager, so the lockfile stays consistent.
4. Afterwards run all checks of the project (lint, type check, tests, build – like the CI). If an update breaks something you cannot fix quickly, revert that update.
5. Do not apply major updates yourself: list them with their most important breaking changes / migration notes (from the changelog or release notes) and an effort estimate.
6. Commit your changes with a clear message, e.g. "chore(deps): update dependencies". Do not push.`,
  },
  security: {
    name: { de: 'Sicherheits-Check', en: 'Security check' },
    cron: '0 5 * * 1',
    prompt: `Do a security check of this project. Do not change any code.

1. ${COMMON_DISCOVERY}
2. Known vulnerabilities in dependencies (npm/pnpm audit, pip-audit, cargo audit, govulncheck, osv-scanner, … – whatever is available) and outdated Docker base images.
3. Secrets committed to the repository: API keys, tokens, passwords, private keys (in the files, and in the recent git history).
4. Insecure configuration: debug mode in production, permissive CORS, missing authentication/authorization checks, insecure cookies or headers.
5. Risky code: SQL/command injection, path traversal, unsafe deserialization, XSS, SSRF.
Rate every finding (critical/high/medium/low) with file and line and a suggested fix.`,
  },
};

/** What a scheduled agent has to do at the end: write its report as JSON to `file`. */
export function reportInstructions(file: string): string {
  return [
    '',
    '---',
    'When you are done, write your result as JSON to ' + file + ' (create the folder if needed; it is excluded from git):',
    '{"status": "ok" or "action_needed", "summary": "one or two sentences", "report": "the full report in Markdown – every check or command with ✅ / ❌ / ⏭ and the important details"}',
    'Use "ok" only if everything passed and nothing needs a human. Use "action_needed" if a check failed, you found a problem you did not fix, or you changed files.',
    'Do not ask questions – decide yourself.',
  ].join('\n');
}

/** Report JSON of a scheduled run; anything unreadable counts as "missing". */
export function parseReport(raw: string, at = new Date().toISOString()): TaskReport {
  try {
    const json = JSON.parse(stripCodeFence(raw)) as { status?: unknown; summary?: unknown; report?: unknown };
    const status = json.status === 'ok' || json.status === 'action_needed' ? json.status : 'missing';
    const summary = typeof json.summary === 'string' && json.summary.trim() ? json.summary.trim().slice(0, 4000) : undefined;
    const details = typeof json.report === 'string' && json.report.trim() ? json.report.trim().slice(0, 50_000) : undefined;
    return { status, summary, details, at };
  } catch {
    return { status: 'missing', at };
  }
}
