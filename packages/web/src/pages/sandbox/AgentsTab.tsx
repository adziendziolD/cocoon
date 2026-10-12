import type { Agent, Sandbox } from '@cocoon/protocol';
import { Bot, Play } from 'lucide-react';
import { AgentList, sortAgents } from '../../components/AgentList';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { SectionTitle } from '../../components/Layout';
import { LoadingState } from '../../components/States';
import { useT } from '../../i18n';

export function AgentsTab({ sandbox, agents, onSpawn, loading }: { sandbox: Sandbox; agents: Agent[]; onSpawn: () => void; loading: boolean }) {
  const t = useT();
  if (loading) return <LoadingState />;
  const live = sortAgents(agents.filter((a) => a.status !== 'exited'));
  const exited = sortAgents(agents.filter((a) => a.status === 'exited'));

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<Bot className="size-6" />}
        title={t('sandboxAgents.empty.title')}
        action={
          <Button variant="primary" icon={<Play className="size-4" />} onClick={onSpawn} disabled={sandbox.status !== 'running'}>
            {t('sandboxAgents.start')}
          </Button>
        }
      >
        {t('sandboxAgents.empty.text')}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle
          action={
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={onSpawn} disabled={sandbox.status !== 'running'}>
              {t('sandboxAgents.start')}
            </Button>
          }
        >
          {t('sandboxAgents.active')}
        </SectionTitle>
        {live.length ? <AgentList agents={live} showSandbox={false} /> : <p className="text-sm text-fg-muted">{t('sandboxAgents.allExited')}</p>}
      </section>
      {exited.length > 0 && (
        <section>
          <SectionTitle>{t('sandboxAgents.exited')}</SectionTitle>
          <p className="mb-2 text-sm text-fg-muted">{t('sandboxAgents.exitedHint')}</p>
          <AgentList agents={exited} showSandbox={false} />
        </section>
      )}
    </div>
  );
}
