import type { Sandbox } from '@cocoon/protocol';
import { Play, Square } from 'lucide-react';
import { qk } from '../api/keys';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { useT } from '../i18n';
import { Button } from './Button';

export function StartStopButton({ sandbox }: { sandbox: Sandbox }) {
  const t = useT();
  const invalidate = [qk.sandbox(sandbox.id), qk.sandboxes, qk.agents];
  const start = useAction(() => rpc('sandbox.start', { sandboxId: sandbox.id }), { success: t('startStop.started'), error: t('startStop.startFailed'), invalidate });
  const stop = useAction(() => rpc('sandbox.stop', { sandboxId: sandbox.id }), { success: t('startStop.stopped'), error: t('startStop.stopFailed'), invalidate });
  if (sandbox.status === 'running') {
    return (
      <Button icon={<Square className="size-4" />} loading={stop.isPending} onClick={() => stop.mutate()} title={t('startStop.stopTitle')}>
        {t('startStop.stop')}
      </Button>
    );
  }
  if (sandbox.status === 'stopped' || sandbox.status === 'error') {
    return (
      <Button variant={sandbox.status === 'stopped' ? 'primary' : 'secondary'} icon={<Play className="size-4" />} loading={start.isPending} onClick={() => start.mutate()}>
        {t('startStop.start')}
      </Button>
    );
  }
  return null;
}
