import { z } from 'zod';
import { NetworkMode, RepoSource } from './models.ts';

/** Short workspace key for task handles and branch names, e.g. "FD" → task FD-12, branch FD-12-add-apple-pay. */
export const WORKSPACE_KEY = /^[A-Z][A-Z0-9]{1,5}$/;

/** Code review that runs when a finished task is approved (review agents in the same sandbox, then push + pull request). */
export const WorkspaceReview = z.object({
  enabled: z.boolean().default(false),
  /** Agent types (keys of settings.agents) that review one after another. */
  agentKinds: z.array(z.string()).min(1).default(['claude-code']),
  /** Own review instructions (replace the default ones; the result format is always added). */
  prompt: z.string().max(20_000).optional(),
  /** The last review agent gets the GitHub token and pushes / opens the pull request itself. */
  agentPushes: z.boolean().default(false),
  /** Target branch of the pull request (default: the repository's default branch). */
  baseBranch: z.string().max(200).optional(),
});
export type WorkspaceReview = z.infer<typeof WorkspaceReview>;

/** Default review instructions ({{…}} placeholders like in workflow prompts). */
export const DEFAULT_REVIEW_PROMPT = `You are a code reviewer. Review the changes that were made in this sandbox for task {{task.key}}.

Task:
{{task}}

Changed files: {{diff}}
Show all changes with \`git diff cocoon-baseline\` (with several repositories, run it in each repository folder).

Check correctness, edge cases, tests, security and readability. Run the tests if there are any. Fix small problems directly, but do not rewrite the solution. Do not ask questions – decide yourself.`;

/** A workspace groups sandboxes, agents and tasks (e.g. one per project or customer). */
export const Workspace = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  /** Key for task handles (FD-12) and branch names. Set by the server for every workspace. */
  key: z.string().regex(WORKSPACE_KEY).optional(),
  /** Number the next task gets. */
  nextTaskNumber: z.number().int().min(1).default(1),
  review: WorkspaceReview.optional(),
  description: z.string().optional(),
  /** Accent color for the UI, e.g. "#6366f1". */
  color: z.string().optional(),
  /** Repository cloned into sandboxes created for this workspace's tasks (older field; see repos). */
  repo: RepoSource.optional(),
  /** Repositories cloned into sandboxes of this workspace (e.g. several services of one platform). */
  repos: z.array(RepoSource).optional(),
  network: NetworkMode.optional(),
  /** "per-task": every task gets its own sandbox (parallel, isolated); "shared": all tasks use one sandbox. */
  sandboxMode: z.enum(['per-task', 'shared']).default('per-task'),
  sharedSandboxId: z.string().optional(),
  /** Default agent type / workflow for new tasks. */
  defaultAgentKind: z.string().default('claude-code'),
  defaultWorkflowId: z.string().optional(),
  /** Start queued tasks automatically (respecting dependencies and maxParallel). */
  autoRun: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(20).default(2),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

/**
 * Task lifecycle: backlog → queued (ready, auto-run picks it up) → running → review (agent finished, waiting for you)
 * → done; or failed. Approving a review continues with the next workflow stage or marks the task done.
 */
export const TaskStatus = z.enum(['backlog', 'queued', 'running', 'review', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['low', 'normal', 'high']);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskRun = z.object({
  stage: z.number().int(),
  stageName: z.string(),
  agentId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  outcome: z.enum(['running', 'finished', 'failed', 'stopped']).default('running'),
});
export type TaskRun = z.infer<typeof TaskRun>;

export const ReviewResult = z.object({
  agentId: z.string(),
  agentKind: z.string(),
  verdict: z.enum(['approved', 'changes_requested', 'missing']),
  summary: z.string().optional(),
  at: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Number within the workspace: handle = <workspace key>-<number>, e.g. FD-12. */
  number: z.number().int().optional(),
  /** FD-12 (set by the server). */
  handle: z.string().optional(),
  /** Git branch for the task's work, e.g. FD-12-add-apple-pay. */
  branch: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  status: TaskStatus,
  priority: TaskPriority.default('normal'),
  /** Position within its column (lower = higher up). */
  order: z.number(),
  /** Single-agent task: agent type. Ignored when workflowId is set. */
  agentKind: z.string().optional(),
  workflowId: z.string().optional(),
  providers: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Tasks that must be done before this one may start. */
  dependsOn: z.array(z.string()).default([]),
  sandboxId: z.string().optional(),
  /** Agent of the current/last stage. */
  agentId: z.string().optional(),
  stage: z.number().int().default(0),
  runs: z.array(TaskRun).default([]),
  /** The current agent is waiting for a human decision. */
  attention: z.boolean().default(false),
  /** Code review after approval: index of the running review agent (undefined = not reviewing). */
  reviewStep: z.number().int().optional(),
  reviews: z.array(ReviewResult).default([]),
  /** Pull requests opened for the task (one per repository). */
  pullRequests: z.array(z.object({ repo: z.string(), url: z.string() })).default([]),
  /** Human-readable progress or error note (rendered in the client's language). */
  note: z.string().optional(),
  /** Message key + parameters behind `note`. */
  noteKey: z.string().optional(),
  noteParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

/** Cockpit layout: a tree of splits whose leaves are panes showing an agent terminal or a tool view. */
export type LayoutNode =
  | { type: 'split'; direction: 'row' | 'column'; sizes: number[]; children: LayoutNode[] }
  | { type: 'pane'; id: string; view: 'agent' | 'board' | 'attention' | 'empty'; agentId?: string };

export const LayoutNode: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('split'),
      direction: z.enum(['row', 'column']),
      sizes: z.array(z.number().positive()),
      children: z.array(LayoutNode).min(1).max(12),
    }),
    z.object({
      type: z.literal('pane'),
      id: z.string(),
      view: z.enum(['agent', 'board', 'attention', 'empty']),
      agentId: z.string().optional(),
    }),
  ]),
);

export const CockpitLayout = z.object({
  root: LayoutNode,
  updatedAt: z.string().optional(),
});
export type CockpitLayout = z.infer<typeof CockpitLayout>;
