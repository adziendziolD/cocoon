import { describe, expect, it } from 'vitest';
import type { Agent, Task } from '@cocoon/protocol';
import { ActivityLog } from './activity.ts';
import { EventBus } from './events.ts';

describe('ActivityLog', () => {
  it('forgets the last status of deleted tasks and removed agents', () => {
    const bus = new EventBus();
    const log = new ActivityLog(bus);
    const maps = log as unknown as { lastTaskStatus: Map<string, string>; lastAgentStatus: Map<string, string> };

    bus.publish({ type: 'task.updated', task: { id: 'ts_1', title: 'A', status: 'backlog', runs: [] } as unknown as Task });
    bus.publish({ type: 'agent.updated', agent: { id: 'ag_1', sandboxId: 'sb_1', kind: 'shell', status: 'working' } as Agent });
    expect(maps.lastTaskStatus.size).toBe(1);
    expect(maps.lastAgentStatus.size).toBe(1);

    bus.publish({ type: 'task.deleted', taskId: 'ts_1', workspaceId: 'ws_1' });
    bus.publish({ type: 'agent.removed', agentId: 'ag_1', sandboxId: 'sb_1' });
    expect(maps.lastTaskStatus.size).toBe(0);
    expect(maps.lastAgentStatus.size).toBe(0);
    expect(log.list(10, 'en').length).toBeGreaterThan(0);
  });
});
