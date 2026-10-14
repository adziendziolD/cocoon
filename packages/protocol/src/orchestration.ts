import { z } from 'zod';
import { GITHUB_TOKEN_NAME, NetworkMode, RepoSource } from './models.ts';

/** A workspace groups sandboxes, agents and tasks (e.g. one per project or customer). */
export const Workspace = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  /** Accent color for the UI, e.g. "#6366f1". */
  color: z.string().optional(),
  /** Repository cloned into sandboxes created for this workspace's tasks (older field; see repos). */
  repo: RepoSource.optional(),
  /** Repositories cloned into sandboxes of this workspace (e.g. several services of one platform). */
  repos: z.array(RepoSource).optional(),
  network: NetworkMode.optional(),
  /** GitHub token (secret name) for this workspace's sandboxes; default: GITHUB_TOKEN. */
  githubToken: z.string().regex(GITHUB_TOKEN_NAME).optional(),
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

export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
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
