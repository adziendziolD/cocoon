import { useMemo } from 'react';
import { useAgents, useSandboxes, useSecrets, useSettings, useSetupStatus } from '../../api/queries';
import { countAiAccess } from '../../lib/providers';
import { isSecretSet } from '../../lib/secrets';
import type { StepStatus } from './context';
import { STEP_IDS, type StepId } from './state';

/**
 * Which steps are already satisfied. Derived from server state wherever possible
 * (setup status, secrets, settings, sandboxes, agents); steps without server state
 * (welcome, defaults) count as done once the user has passed them in this session.
 */
export function useStepStatus(passed: StepId[]): Record<StepId, StepStatus> {
  const setup = useSetupStatus();
  const secrets = useSecrets();
  const settings = useSettings();
  const sandboxes = useSandboxes();
  const agents = useAgents();

  return useMemo(() => {
    const setupDone = (id: string) => !!setup.data?.steps.find((s) => s.id === id)?.done;
    const wasPassed = (id: StepId) => passed.includes(id);
    const done: Record<StepId, boolean> = {
      welcome: wasPassed('welcome'),
      system: setupDone('docker') && setupDone('image') && setupDone('proxy'),
      ai: countAiAccess(settings.data, secrets.data) > 0 || setupDone('credentials'),
      github: isSecretSet(secrets.data, 'GITHUB_TOKEN'),
      defaults: wasPassed('defaults'),
      sandbox: (sandboxes.data?.length ?? 0) > 0,
      agent: (agents.data?.length ?? 0) > 0,
      done: false,
    };
    return Object.fromEntries(STEP_IDS.map((id) => [id, done[id] ? 'done' : wasPassed(id) ? 'skipped' : 'open'])) as Record<StepId, StepStatus>;
  }, [setup.data, secrets.data, settings.data, sandboxes.data, agents.data, passed]);
}
