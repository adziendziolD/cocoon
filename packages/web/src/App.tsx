import { useSyncExternalStore } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { getToken, subscribeToken } from './lib/auth';
import { ActivityPage } from './pages/ActivityPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { CockpitPage } from './pages/cockpit/CockpitPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OnboardingPage } from './pages/onboarding/OnboardingPage';
import { SandboxDetailPage } from './pages/sandbox/SandboxDetailPage';
import { SandboxesPage } from './pages/SandboxesPage';
import { TasksPage } from './pages/TasksPage';
import { WorkspaceDetailPage } from './pages/WorkspaceDetailPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { AccessSettings } from './pages/settings/AccessSettings';
import { AdvancedSettings } from './pages/settings/AdvancedSettings';
import { AgentProfilesSettings } from './pages/settings/AgentProfilesSettings';
import { GeneralSettings } from './pages/settings/GeneralSettings';
import { NetworkSettings } from './pages/settings/NetworkSettings';
import { NotificationsSettings } from './pages/settings/NotificationsSettings';
import { ProvidersSettings } from './pages/settings/ProvidersSettings';
import { SandboxDefaultsSettings } from './pages/settings/SandboxDefaultsSettings';
import { ServicesSettings } from './pages/settings/ServicesSettings';
import { SecretsSettings } from './pages/settings/SecretsSettings';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { UpdatesSettings } from './pages/settings/UpdatesSettings';
import { WorkflowsSettings } from './pages/settings/WorkflowsSettings';

export function App() {
  const token = useSyncExternalStore(subscribeToken, getToken);
  if (!token) return <LoginPage />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="onboarding" element={<OnboardingPage />} />
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="cockpit" element={<CockpitPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route path="workspaces/:workspaceId" element={<WorkspaceDetailPage />} />
          <Route path="workspaces/:workspaceId/:tab" element={<WorkspaceDetailPage />} />
          <Route path="sandboxes" element={<SandboxesPage />} />
          <Route path="sandboxes/:sandboxId" element={<SandboxDetailPage />} />
          <Route path="sandboxes/:sandboxId/:tab" element={<SandboxDetailPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<AgentDetailPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="secrets" replace />} />
            <Route path="general" element={<GeneralSettings />} />
            <Route path="secrets" element={<SecretsSettings />} />
            <Route path="providers" element={<ProvidersSettings />} />
            <Route path="agents" element={<AgentProfilesSettings />} />
            <Route path="workflows" element={<WorkflowsSettings />} />
            <Route path="sandbox" element={<SandboxDefaultsSettings />} />
            <Route path="services" element={<ServicesSettings />} />
            <Route path="network" element={<NetworkSettings />} />
            <Route path="notifications" element={<NotificationsSettings />} />
            <Route path="access" element={<AccessSettings />} />
            <Route path="advanced" element={<AdvancedSettings />} />
            <Route path="updates" element={<UpdatesSettings />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
