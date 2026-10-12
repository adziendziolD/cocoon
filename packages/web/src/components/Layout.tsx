import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useMatch } from 'react-router-dom';
import { Activity, Bot, Boxes, KanbanSquare, Layers, LayoutDashboard, Menu, MonitorPlay, Settings, X } from 'lucide-react';
import { useConnectionState, useEventSync } from '../api/events';
import { useAgents, useSystemInfo, useTasks, useUpdateStatus } from '../api/queries';
import { useT, type MessageKey } from '../i18n';
import { cn } from '../lib/cn';
import { useOnboardingRedirect } from '../pages/onboarding/lifecycle';
import { AppDialogsProvider, useAppDialogs } from './AppDialogs';
import { LanguageSwitcher } from './LanguageSwitcher';
import { Logo } from './Logo';
import { LoadingState } from './States';

/** Opens the "Neue Sandbox" wizard from anywhere in the app (use useAppDialogs().createSandbox to preselect a workspace). */
export const useOpenCreateSandbox = () => {
  const { createSandbox } = useAppDialogs();
  return () => createSandbox();
};

type NavId = 'dashboard' | 'cockpit' | 'tasks' | 'workspaces' | 'sandboxes' | 'agents' | 'activity' | 'settings';
const NAV: Array<{ id: NavId; to: string; label: MessageKey; icon: typeof Activity; end?: boolean; prominent?: boolean; gapBefore?: boolean }> = [
  { id: 'dashboard', to: '/', label: 'layout.nav.dashboard', icon: LayoutDashboard, end: true },
  { id: 'cockpit', to: '/cockpit', label: 'layout.nav.cockpit', icon: MonitorPlay, prominent: true },
  { id: 'tasks', to: '/tasks', label: 'layout.nav.tasks', icon: KanbanSquare },
  { id: 'workspaces', to: '/workspaces', label: 'layout.nav.workspaces', icon: Layers, gapBefore: true },
  { id: 'sandboxes', to: '/sandboxes', label: 'layout.nav.sandboxes', icon: Boxes },
  { id: 'agents', to: '/agents', label: 'layout.nav.agents', icon: Bot },
  { id: 'activity', to: '/activity', label: 'layout.nav.activity', icon: Activity, gapBefore: true },
  { id: 'settings', to: '/settings', label: 'layout.nav.settings', icon: Settings },
];

export function Layout() {
  useEventSync(true);
  return (
    <AppDialogsProvider>
      <Shell />
    </AppDialogsProvider>
  );
}

function Shell() {
  const t = useT();
  const redirectPending = useOnboardingRedirect();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const agents = useAgents();
  const tasks = useTasks();
  const blocked = agents.data?.filter((a) => a.status === 'blocked').length ?? 0;
  const review = tasks.data?.filter((x) => x.status === 'review').length ?? 0;
  // The cockpit uses the full window (no page padding / max width).
  const fullBleed = !!useMatch('/cockpit');
  const updates = useUpdateStatus().data?.available.length ?? 0;
  const badges: Partial<Record<NavId, { count: number; title: string }>> = {
    cockpit: { count: blocked + review, title: t('layout.cockpitBadge') },
    tasks: { count: review, title: t('layout.reviewBadge') },
    agents: { count: blocked, title: t('layout.blockedBadge') },
    settings: { count: updates, title: t('layout.updatesBadge') },
  };

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    document.title = blocked > 0 ? t('layout.docTitleBlocked', { count: blocked }) : 'CoCoon';
  }, [blocked, t]);

  return (
    <>
      <div className="flex min-h-full">
        {/* Mobile top bar */}
        <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:hidden">
          <button onClick={() => setMenuOpen((o) => !o)} className="rounded-md p-1.5 text-fg-muted hover:bg-surface-2" aria-label={t('common.menu')}>
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
          <Logo />
        </div>

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r border-line bg-surface transition-transform md:translate-x-0',
            menuOpen ? 'translate-x-0 pt-14' : '-translate-x-full md:pt-0',
          )}
        >
          <div className="hidden h-16 items-center px-5 md:flex">
            <Logo />
          </div>
          <nav className="flex-1 space-y-0.5 px-3 py-2">
            {NAV.map(({ id, to, label, icon: Icon, end, prominent, gapBefore }) => {
              const badge = badges[id];
              return (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      gapBefore && 'mt-3',
                      isActive
                        ? prominent
                          ? 'bg-accent text-accent-fg shadow-sm'
                          : 'bg-accent-soft text-accent'
                        : prominent
                          ? 'text-fg ring-1 ring-accent/30 ring-inset hover:bg-accent-soft'
                          : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                    )
                  }
                >
                  <Icon className="size-4.5" />
                  <span className="flex-1">{t(label)}</span>
                  {badge && badge.count > 0 && (
                    <span className="rounded-full bg-amber-400 px-1.5 py-px text-xs font-semibold text-amber-950" title={badge.title}>
                      {badge.count}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
          <SidebarFooter />
        </aside>

        <main className="min-w-0 flex-1 pt-14 md:pt-0 md:pl-60">
          {fullBleed ? (
            <div className="h-[calc(100vh-3.5rem)] md:h-screen">{redirectPending ? <LoadingState /> : <Outlet />}</div>
          ) : (
            <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{redirectPending ? <LoadingState /> : <Outlet />}</div>
          )}
        </main>
      </div>
    </>
  );
}

function SidebarFooter() {
  const conn = useConnectionState();
  const info = useSystemInfo();
  const t = useT();
  const meta = {
    open: { dot: 'bg-emerald-500', label: t('layout.conn.open'), hint: t('layout.conn.openHint') },
    connecting: { dot: 'bg-amber-500 animate-status', label: t('layout.conn.connecting'), hint: t('layout.conn.connectingHint') },
    closed: { dot: 'bg-red-500', label: t('layout.conn.closed'), hint: t('layout.conn.closedHint') },
  }[conn];
  return (
    <div className="border-t border-line px-5 py-3.5 text-xs">
      <div className="flex items-center gap-2 text-fg-muted" title={meta.hint}>
        <span className={cn('size-2 rounded-full', meta.dot)} />
        {meta.label}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-fg-subtle">{info.data ? t('layout.version', { version: info.data.version }) : ''}</span>
        <LanguageSwitcher />
      </div>
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}
