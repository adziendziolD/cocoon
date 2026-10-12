import type { TFunction } from '../i18n';

/** Plain-language explanations of OCI runtimes offered by the server. */
export function runtimeInfo(t: TFunction, runtime: string | null | undefined): { label: string; description: string } {
  if (!runtime || runtime === 'runc') {
    return { label: t('runtime.runc.label'), description: t('runtime.runc.description') };
  }
  if (runtime === 'runsc' || runtime.startsWith('runsc')) {
    return { label: 'gVisor (runsc)', description: t('runtime.runsc.description') };
  }
  if (runtime === 'crun') {
    return { label: t('runtime.crun.label'), description: t('runtime.crun.description') };
  }
  if (runtime === 'krun' || runtime.startsWith('krun')) {
    return { label: t('runtime.krun.label'), description: t('runtime.krun.description') };
  }
  if (runtime.startsWith('kata')) {
    return {
      label: runtime === 'kata-fc' ? t('runtime.kataFc.label') : `Kata Containers (${runtime})`,
      description: t('runtime.kata.description'),
    };
  }
  return { label: runtime, description: t('runtime.custom.description') };
}

export const SIZE_PRESETS = [
  { id: 'small', cpus: 1, memoryMb: 2048 },
  { id: 'medium', cpus: 2, memoryMb: 4096 },
  { id: 'large', cpus: 4, memoryMb: 8192 },
] as const;
export type SizePresetId = (typeof SIZE_PRESETS)[number]['id'];

export function sizePresetLabel(t: TFunction, id: SizePresetId): string {
  return t(`size.${id}.label`);
}

export function sizePresetDescription(t: TFunction, id: SizePresetId): string {
  return t(`size.${id}.description`);
}
