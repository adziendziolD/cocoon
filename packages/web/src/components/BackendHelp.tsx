import type { ReactNode } from 'react';
import { rich, useT } from '../i18n';
import { useBackend } from '../lib/backend';
import { CodeBlock } from './CodeBlock';
import { Callout } from './HelpText';

const code = (c: string) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">{c}</code>;

function Option({ title, children, install }: { title: string; children: ReactNode; install: string }) {
  return (
    <li>
      <span className="font-medium text-fg">{title}</span> – {children}
      <CodeBlock className="mt-1.5" code={install} />
    </li>
  );
}

/** Troubleshooting when the sandbox backend (Docker, Podman or bubblewrap) can't be reached. */
export function BackendHelp({ className }: { className?: string }) {
  const t = useT();
  const { kind, name } = useBackend();
  const check =
    kind === 'docker' ? 'docker info' : kind === 'podman' ? 'podman info' : kind === 'bwrap' ? 'bwrap --version && tmux -V' : 'docker info\npodman info\nbwrap --version';
  return (
    <Callout
      tone="danger"
      className={className}
      title={name ? t('onboarding.system.backendHelpTitleNamed', { name }) : t('onboarding.system.backendHelpTitle')}
    >
      <p className="mt-1">{t('onboarding.system.backendHelpIntro')}</p>
      <ul className="mt-2 space-y-3">
        <Option title="Docker" install={'curl -fsSL https://get.docker.com | sh\nsudo usermod -aG docker $USER   # ' + t('onboarding.system.backendRelogin')}>
          {rich(t('onboarding.system.backendHelpDocker'), {
            group: code('docker'),
            link: (
              <a href="https://docs.docker.com/engine/install/" target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                docs.docker.com
              </a>
            ),
          })}
        </Option>
        <Option title="Podman" install={'sudo apt install podman      # Debian/Ubuntu\nsudo dnf install podman      # Fedora/RHEL\nsystemctl --user enable --now podman.socket'}>
          {t('onboarding.system.backendHelpPodman')}
        </Option>
        <Option title="bubblewrap" install="sudo apt install bubblewrap tmux">
          {t('onboarding.system.backendHelpBwrap')}
        </Option>
      </ul>
      <p className="mt-3">{rich(t('onboarding.system.backendHelpSwitch'), { env: code('COCOON_DRIVER=auto|docker|podman|bwrap') })}</p>
      <CodeBlock className="mt-3" title={t('onboarding.system.backendTestTitle')} code={check} />
    </Callout>
  );
}
