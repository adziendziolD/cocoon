import { NavLink, Outlet } from 'react-router-dom';
import { ArrowUpCircle, Bell, Bot, Boxes, Database, Globe, KeyRound, Plug, Server, ShieldCheck, SlidersHorizontal, Workflow } from 'lucide-react';
import { useUpdateStatus } from '../../api/queries';
import { PageHeader } from '../../components/Card';
import { useT, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';

const SECTIONS: Array<{ to: string; label: MessageKey; icon: typeof Bot }> = [
  { to: 'general', label: 'settingsNav.general', icon: Globe },
  { to: 'secrets', label: 'settingsNav.secrets', icon: KeyRound },
  { to: 'providers', label: 'settingsNav.providers', icon: Server },
  { to: 'agents', label: 'settingsNav.agents', icon: Bot },
  { to: 'workflows', label: 'settingsNav.workflows', icon: Workflow },
  { to: 'sandbox', label: 'settingsNav.sandbox', icon: Boxes },
  { to: 'services', label: 'settingsNav.services', icon: Database },
  { to: 'network', label: 'settingsNav.network', icon: ShieldCheck },
  { to: 'notifications', label: 'settingsNav.notifications', icon: Bell },
  { to: 'access', label: 'settingsNav.access', icon: Plug },
  { to: 'advanced', label: 'settingsNav.advanced', icon: SlidersHorizontal },
  { to: 'updates', label: 'settingsNav.updates', icon: ArrowUpCircle },
];

export function SettingsLayout() {
  const t = useT();
  const updates = useUpdateStatus().data?.available.length ?? 0;
  return (
    <>
      <PageHeader title={t('settingsNav.title')} description={t('settingsNav.description')} />
      <div className="grid gap-6 lg:grid-cols-[230px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                  isActive ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <Icon className="size-4" />
              {t(label)}
              {to === 'updates' && updates > 0 && (
                <span className="ml-auto rounded-full bg-amber-400 px-1.5 py-px text-xs font-semibold text-amber-950" title={t('layout.updatesBadge')}>
                  {updates}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </>
  );
}
