import { localize, type AgentProfile, type Language } from '@cocoon/protocol';
import { getLanguage } from '../i18n';

export function profileLabel(kind: string, profile?: AgentProfile, lang: Language = getLanguage()): string {
  return localize(profile?.label, lang) || kind;
}

export function profileDescription(profile: AgentProfile | undefined, lang: Language = getLanguage()): string | undefined {
  return localize(profile?.description, lang) || undefined;
}

/** Shell-like agent types (plain terminals) take commands, not tasks. */
export function isShellProfile(kind: string, profile?: AgentProfile): boolean {
  return kind === 'shell' || !!(profile?.command[0] && /^(ba|z|)sh$/.test(profile.command[0]));
}
