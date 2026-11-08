import { NavLink, Outlet } from 'react-router-dom';
import { ArrowUpCircle, Bell, Bot, Boxes, Database, Globe, KeyRound, Plug, Server, ShieldCheck, SlidersHorizontal, UserCircle, Users, Workflow } from 'lucide-react';
import { useUpdateStatus } from '../../api/queries';
import { PageHeader } from '../../components/Card';
import { useT, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import { useIdentity } from '../../lib/identity';

/** `admin`: only admins see the page (the server refuses members anyway). */
const SECTIONS: Array<{ to: string; label: MessageKey; icon: typeof Bot; admin?: true }> = [
  { to: 'general', label: 'settingsNav.general', icon: Globe, admin: true },
  { to: 'secrets', label: 'settingsNav.secrets', icon: KeyRound, admin: true },
  { to: 'providers', label: 'settingsNav.providers', icon: Server, admin: true },
  { to: 'agents', label: 'settingsNav.agents', icon: Bot, admin: true },
  { to: 'workflows', label: 'settingsNav.workflows', icon: Workflow, admin: true },
  { to: 'sandbox', label: 'settingsNav.sandbox', icon: Boxes, admin: true },
  { to: 'services', label: 'settingsNav.services', icon: Database, admin: true },
  { to: 'network', label: 'settingsNav.network', icon: ShieldCheck, admin: true },
  { to: 'notifications', label: 'settingsNav.notifications', icon: Bell, admin: true },
  { to: 'users', label: 'settingsNav.users', icon: Users, admin: true },
  { to: 'access', label: 'settingsNav.access', icon: Plug, admin: true },
  { to: 'advanced', label: 'settingsNav.advanced', icon: SlidersHorizontal, admin: true },
  { to: 'updates', label: 'settingsNav.updates', icon: ArrowUpCircle, admin: true },
  { to: 'account', label: 'settingsNav.account', icon: UserCircle },
];

export function SettingsLayout() {
  const t = useT();
  const { isAdmin } = useIdentity();
  const updates = useUpdateStatus(isAdmin).data?.available.length ?? 0;
  const sections = SECTIONS.filter((section) => isAdmin || !section.admin);
  return (
    <>
      <PageHeader title={t('settingsNav.title')} description={isAdmin ? t('settingsNav.description') : t('settingsNav.descriptionMember')} />
      <div className="grid gap-6 lg:grid-cols-[230px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {sections.map(({ to, label, icon: Icon }) => (
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
