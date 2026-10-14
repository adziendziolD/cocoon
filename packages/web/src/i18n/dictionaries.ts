import * as agents from './messages/agents';
import * as common from './messages/common';
import * as cockpit from './messages/cockpit';
import * as components from './messages/components';
import * as limits from './messages/limits';
import * as onboarding from './messages/onboarding';
import * as orchestration from './messages/orchestration';
import * as providers from './messages/providers';
import * as sandbox from './messages/sandbox';
import * as services from './messages/services';
import * as settings from './messages/settings';
import * as workflows from './messages/workflows';
import * as ports from './messages/ports';
import * as env from './messages/env';
import * as updates from './messages/updates';
import type { Messages } from './types';

/**
 * German is the source language. Each area keeps its texts in its own module (messages/*.ts);
 * the English dictionary is typed against the German one, so a missing translation is a compile error.
 */
export const de = {
  ...common.de,
  ...components.de,
  ...sandbox.de,
  ...settings.de,
  ...providers.de,
  ...onboarding.de,
  ...orchestration.de,
  ...cockpit.de,
  ...workflows.de,
  ...agents.de,
  ...limits.de,
  ...services.de,
  ...updates.de,
  ...ports.de,
  ...env.de,
};

export type MessageKey = keyof typeof de;

export const en: Messages<typeof de> = {
  ...common.en,
  ...components.en,
  ...sandbox.en,
  ...settings.en,
  ...providers.en,
  ...onboarding.en,
  ...orchestration.en,
  ...cockpit.en,
  ...workflows.en,
  ...agents.en,
  ...limits.en,
  ...services.en,
  ...updates.en,
  ...ports.en,
  ...env.en,
};
