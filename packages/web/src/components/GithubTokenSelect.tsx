import { isGithubTokenName } from '@cocoon/protocol';
import { useSecrets } from '../api/queries';
import { useT } from '../i18n';
import { Select } from './Field';

/** Picks which stored GitHub token to use. '' = inherit (workspace token, then the default GITHUB_TOKEN). */
export function GithubTokenSelect({ value, onChange, inheritLabel }: { value: string; onChange: (value: string) => void; inheritLabel?: string }) {
  const t = useT();
  const tokens = (useSecrets().data ?? []).filter((s) => s.set && isGithubTokenName(s.name) && s.name !== 'GITHUB_TOKEN');
  const defaultSet = (useSecrets().data ?? []).some((s) => s.name === 'GITHUB_TOKEN' && s.set);
  const known = value === '' || value === 'GITHUB_TOKEN' || tokens.some((s) => s.name === value);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{inheritLabel ?? t('githubToken.default')}</option>
      {defaultSet && inheritLabel && <option value="GITHUB_TOKEN">GITHUB_TOKEN</option>}
      {tokens.map((s) => (
        <option key={s.name} value={s.name}>
          {s.name}
        </option>
      ))}
      {!known && <option value={value}>{t('githubToken.missing', { name: value })}</option>}
    </Select>
  );
}
