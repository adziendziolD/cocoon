import { useState } from 'react';
import { ExternalLink, GitBranch, GitPullRequest, Lock, Upload } from 'lucide-react';
import { useSecrets } from '../../../api/queries';
import { useSaveSecret } from '../../../api/useSaveSecret';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { SecretInput } from '../../../components/SecretInput';
import { rich, useT } from '../../../i18n';
import { useDraftField, useOnboarding } from '../context';
import { HowTo, StepFrame, StoredSecret } from '../StepFrame';

const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

export function GithubStep() {
  const t = useT();
  const { next } = useOnboarding();
  const secrets = useSecrets();
  const info = secrets.data?.find((s) => s.name === 'GITHUB_TOKEN' && s.set);
  const [value, setValue] = useDraftField('secret.GITHUB_TOKEN', '');
  const [replace, setReplace] = useState(false);
  const save = useSaveSecret('GITHUB_TOKEN', {
    onSuccess: () => {
      setValue('');
      setReplace(false);
    },
  });
  const b = (s: string) => <strong className="font-medium text-fg">{s}</strong>;

  return (
    <StepFrame
      icon={GitBranch}
      title={t('onboarding.github.title')}
      lead={t('onboarding.github.lead')}
      onNext={next}
      nextLabel={info ? undefined : t('onboarding.github.skip')}
      footerHint={info ? undefined : t('onboarding.github.skipHint')}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: Lock, text: t('onboarding.github.use1') },
          { icon: Upload, text: t('onboarding.github.use2') },
          { icon: GitPullRequest, text: t('onboarding.github.use3') },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-3 rounded-xl border border-line bg-surface-2/40 px-3.5 py-3 text-sm text-fg">
            <Icon className="size-4.5 shrink-0 text-accent" />
            {text}
          </div>
        ))}
      </div>

      <div>
        <div className="mb-3 text-sm font-medium text-fg">{t('onboarding.github.howTitle')}</div>
        <HowTo
          steps={[
            <>
              {t('onboarding.github.how1')}{' '}
              <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                {t('onboarding.github.open')} <ExternalLink className="size-3.5" />
              </a>
            </>,
            t('onboarding.github.how2'),
            rich(t('onboarding.github.how3'), { access: b('Repository access') }),
            <>
              {rich(t('onboarding.github.how4'), { permissions: b('Repository permissions') })}
              <ul className="mt-1.5 space-y-1">
                <li>
                  {b('Contents')} → <code className="rounded bg-surface-2 px-1 font-mono text-xs">Read and write</code>
                </li>
                <li>
                  {b('Pull requests')} → <code className="rounded bg-surface-2 px-1 font-mono text-xs">Read and write</code>
                </li>
              </ul>
            </>,
            rich(t('onboarding.github.how5'), { generate: b('Generate token') }),
          ]}
        />
      </div>

      <Field label={t('onboarding.github.field')} hint={t('secrets.editor.neverShown')}>
        {info && !replace ? (
          <StoredSecret info={info}>
            <Button size="sm" onClick={() => setReplace(true)}>
              {t('providers.form.replaceKey')}
            </Button>
          </StoredSecret>
        ) : (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) save.mutate(value.trim());
            }}
          >
            <SecretInput value={value} onChange={(e) => setValue(e.target.value)} placeholder="github_pat_…" aria-label={t('onboarding.github.field')} className="min-w-60" />
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!value.trim()}>
              {t('common.save')}
            </Button>
            {replace && <Button onClick={() => setReplace(false)}>{t('common.cancel')}</Button>}
          </form>
        )}
      </Field>
    </StepFrame>
  );
}
