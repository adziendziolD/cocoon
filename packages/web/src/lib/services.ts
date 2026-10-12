import { SERVICE_KINDS, type ServiceInfo, type ServiceStatus } from '@cocoon/protocol';
import type { TFunction } from '../i18n';
import type { StatusMeta, Tone } from './status';

const SERVICE_TONE: Record<ServiceStatus, { tone: Tone; animated?: boolean }> = {
  running: { tone: 'green' },
  starting: { tone: 'blue', animated: true },
  pulling: { tone: 'blue', animated: true },
  idle: { tone: 'slate' },
  stopped: { tone: 'slate' },
  error: { tone: 'red' },
  unsupported: { tone: 'gray' },
};

/** Label, colour and explanation of a shared-service status in the active language. */
export function serviceStatusMeta(t: TFunction, status: ServiceStatus): StatusMeta {
  const s = status in SERVICE_TONE ? status : 'error';
  return { ...SERVICE_TONE[s], label: t(`services.status.${s}`), explanation: t(`services.status.${s}.explanation`) };
}

/** Display name of a service: custom label, else the catalog label (plus the id if several services share a kind). */
export function serviceLabel(service: ServiceInfo, all?: ServiceInfo[]): string {
  if (service.label) return service.label;
  const base = SERVICE_KINDS[service.kind].label;
  const sameKind = all?.filter((s) => s.kind === service.kind).length ?? 0;
  return sameKind > 1 && service.id !== service.kind ? `${base} (${service.id})` : base;
}

/** Replaces a password inside a connection URL with dots. */
export function maskSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('••••••••');
}
