import { z } from 'zod';
import { ActivityEntry, Agent, ImageKind, Sandbox, SandboxPort, Settings, UpdateStatus } from './models.ts';
import { Task, Workspace } from './orchestration.ts';
import { ServiceInfo } from './services.ts';

export const CocoonEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sandbox.updated'), sandbox: Sandbox }),
  z.object({ type: z.literal('sandbox.deleted'), sandboxId: z.string() }),
  z.object({ type: z.literal('agent.updated'), agent: Agent }),
  z.object({ type: z.literal('agent.removed'), agentId: z.string(), sandboxId: z.string() }),
  z.object({ type: z.literal('settings.updated'), settings: Settings }),
  z.object({
    type: z.literal('image.build'),
    buildId: z.string(),
    kind: ImageKind,
    status: z.enum(['running', 'succeeded', 'failed']),
    line: z.string().optional(),
    error: z.string().optional(),
  }),
  /** Log of a CoCoon self-update (git, pnpm install, web build). */
  z.object({
    type: z.literal('update.progress'),
    buildId: z.string(),
    status: z.enum(['running', 'succeeded', 'failed']),
    line: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('update.status'), status: UpdateStatus }),
  z.object({ type: z.literal('ports.updated'), sandboxId: z.string(), ports: z.array(SandboxPort) }),
  z.object({ type: z.literal('activity'), entry: ActivityEntry }),
  z.object({ type: z.literal('workspace.updated'), workspace: Workspace }),
  z.object({ type: z.literal('workspace.deleted'), workspaceId: z.string() }),
  z.object({ type: z.literal('task.updated'), task: Task }),
  z.object({ type: z.literal('task.deleted'), taskId: z.string(), workspaceId: z.string() }),
  z.object({ type: z.literal('service.updated'), service: ServiceInfo }),
  z.object({ type: z.literal('service.removed'), serviceId: z.string() }),
]);
export type CocoonEvent = z.infer<typeof CocoonEvent>;
export type CocoonEventType = CocoonEvent['type'];

export const EventFilter = z.object({
  types: z.array(z.string()).optional(),
  sandboxId: z.string().optional(),
  agentId: z.string().optional(),
});
export type EventFilter = z.infer<typeof EventFilter>;

function sandboxOf(event: CocoonEvent): string | undefined {
  switch (event.type) {
    case 'sandbox.updated': return event.sandbox.id;
    case 'agent.updated': return event.agent.sandboxId;
    case 'sandbox.deleted':
    case 'agent.removed': return event.sandboxId;
    case 'activity': return event.entry.sandboxId;
    case 'task.updated': return event.task.sandboxId;
    case 'ports.updated': return event.sandboxId;
    default: return undefined;
  }
}

function agentOf(event: CocoonEvent): string | undefined {
  switch (event.type) {
    case 'agent.updated': return event.agent.id;
    case 'agent.removed': return event.agentId;
    case 'activity': return event.entry.agentId;
    case 'task.updated': return event.task.agentId;
    default: return undefined;
  }
}

export function matchesFilter(event: CocoonEvent, filter: EventFilter): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false;
  if (filter.sandboxId && filter.sandboxId !== sandboxOf(event)) return false;
  if (filter.agentId && filter.agentId !== agentOf(event)) return false;
  return true;
}
