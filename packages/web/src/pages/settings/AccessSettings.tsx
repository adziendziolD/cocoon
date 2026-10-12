import { useState } from 'react';
import { KeyRound, LogOut, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { qk } from '../../api/keys';
import { useTokens } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { CodeBlock } from '../../components/CodeBlock';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { clearToken } from '../../lib/auth';
import { rich, useT } from '../../i18n';
import { formatDateTime, formatRelative } from '../../lib/format';

export function AccessSettings() {
  const t = useT();
  const tokens = useTokens();
  const [createOpen, setCreateOpen] = useState(false);
  const [toRevoke, setToRevoke] = useState<{ id: string; name: string } | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const origin = window.location.origin;

  const revoke = useAction((id: string) => rpc('tokens.revoke', { id }), {
    success: t('access.revoked'),
    error: t('access.revokeFailed'),
    invalidate: [qk.tokens],
    onSuccess: () => setToRevoke(null),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('access.tokens.title')}
          description={t('access.tokens.description')}
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
              {t('access.tokens.new')}
            </Button>
          }
        />
        {tokens.isLoading ? (
          <LoadingState />
        ) : tokens.error ? (
          <ErrorState error={tokens.error} className="m-4" onRetry={() => tokens.refetch()} />
        ) : !tokens.data?.length ? (
          <CardBody className="text-sm text-fg-muted">{t('access.tokens.empty')}</CardBody>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.data.map((tok) => (
              <li key={tok.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <KeyRound className="size-4 text-fg-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-fg">{tok.name}</div>
                  <div className="text-xs text-fg-subtle">
                    <span className="font-mono">{tok.preview}</span> · {t('access.tokens.created', { date: formatDateTime(tok.createdAt) })} ·{' '}
                    {tok.lastUsedAt ? t('access.tokens.lastUsed', { time: formatRelative(tok.lastUsedAt) }) : t('access.tokens.neverUsed')}
                  </div>
                </div>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setToRevoke(tok)}>
                  {t('access.tokens.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title={t('access.mcp.title')}
          description={t('access.mcp.description')}
        />
        <CardBody className="space-y-3">
          <CodeBlock title="Claude Code" code={`claude mcp add --transport http cocoon ${origin}/mcp --header "Authorization: Bearer <TOKEN>"`} />
          <CodeBlock
            title={t('access.mcp.otherClients')}
            code={JSON.stringify({ mcpServers: { cocoon: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('access.cli.title')} description={t('access.cli.description')} />
        <CardBody>
          <CodeBlock
            code={`export COCOON_URL=${origin}
export COCOON_TOKEN=<TOKEN>

pnpm cocoon setup
pnpm cocoon sandbox ls
pnpm cocoon sandbox create --name ${t('access.cli.exampleName')} --repo https://github.com/name/${t('access.cli.exampleName')}
pnpm cocoon agent spawn <sandbox-id> claude-code -p "${t('access.cli.examplePrompt')}"
pnpm cocoon agent wait <agent-id>
pnpm cocoon attach <agent-id>`}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('access.logout.title')} />
        <CardBody className="flex flex-wrap items-center gap-4">
          <p className="flex-1 text-sm text-fg-muted">{t('access.logout.text')}</p>
          <Button icon={<LogOut className="size-4" />} onClick={() => setConfirmLogout(true)}>
            {t('access.logout.button')}
          </Button>
        </CardBody>
      </Card>

      <CreateTokenDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog
        open={!!toRevoke}
        onClose={() => setToRevoke(null)}
        onConfirm={() => toRevoke && revoke.mutate(toRevoke.id)}
        loading={revoke.isPending}
        danger
        title={t('access.revoke.title')}
        confirmLabel={t('access.tokens.revoke')}
        message={rich(t('access.revoke.message'), { name: <strong className="text-fg">{toRevoke?.name}</strong> })}
      />
      <ConfirmDialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => clearToken()}
        title={t('access.logout.confirmTitle')}
        confirmLabel={t('access.logout.button')}
        message={t('access.logout.confirmMessage')}
      />
    </div>
  );
}

function CreateTokenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction((n: string) => rpc('tokens.create', { name: n }), {
    success: t('access.create.success'),
    error: t('access.create.failed'),
    invalidate: [qk.tokens],
    onSuccess: (r) => setCreated(r.token),
  });
  const close = () => {
    setName('');
    setCreated(null);
    onClose();
  };

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={close}
        title={t('access.create.doneTitle')}
        dismissable={false}
        footer={
          <Button variant="primary" onClick={close}>
            {t('access.create.savedIt')}
          </Button>
        }
      >
        <div className="space-y-3">
          <Callout tone="warning" title={t('access.create.onlyNowTitle')}>
            {t('access.create.onlyNowText')}
          </Callout>
          <CodeBlock code={created} />
          <p className="flex items-start gap-1.5 text-xs text-fg-muted">
            <TriangleAlert className="mt-px size-3.5 shrink-0" /> {t('access.create.warning')}
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={t('access.create.title')}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate(name.trim())}>
            {t('access.create.submit')}
          </Button>
        </>
      }
    >
      <Field label={t('common.name')} hint={t('access.create.nameHint')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create.mutate(name.trim())} />
      </Field>
    </Dialog>
  );
}
