import type { DriverCapabilities, DriverKind } from '@cocoon/protocol';
import { useSystemInfo } from '../api/queries';
import type { TFunction } from '../i18n';

/** Assumed while system.info is loading, so no warnings flash up before we know better. */
const FULL_CAPABILITIES: DriverCapabilities = { images: true, resourceLimits: true, enforcedEgress: true, runtimes: true };

const BACKEND_LABEL: Record<DriverKind, string> = { docker: 'Docker', podman: 'Podman', bwrap: 'bubblewrap' };

/** Display name of a sandbox backend ("Docker", "Podman", "bubblewrap"). */
export function backendLabel(kind: DriverKind | undefined, fallback?: string): string {
  return kind ? BACKEND_LABEL[kind] : (fallback ?? '');
}

/** One-line, plain-language explanation of a sandbox backend. */
export function backendDescription(t: TFunction, kind: DriverKind): string {
  return t(`backend.${kind}.description`);
}

/** The server's sandbox backend and what it can do. */
export function useBackend() {
  const info = useSystemInfo();
  const kind = info.data?.driverKind;
  return {
    info,
    kind,
    /** Display name; falls back to the server's driver name or a neutral term. */
    name: kind ? BACKEND_LABEL[kind] : info.data?.driver,
    capabilities: info.data?.capabilities ?? FULL_CAPABILITIES,
  };
}

/** Display name of an agent CLI in the toolbox ("Claude Code", "OpenCode", …). */
export { toolLabel as agentToolLabel } from './compat';
