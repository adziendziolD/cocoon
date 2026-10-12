import type { AgentStatus, MethodResult, NotificationEvent } from '@cocoon/protocol';
import type { EventBus } from './events.ts';
import { t, type MessageKey } from './i18n.ts';
import type { SettingsService } from './settings.ts';
import type { Store } from './store.ts';

type Params = Record<string, string | number>;

/**
 * Sends notifications to an incoming webhook. The payload works with Slack and Mattermost ("text"),
 * Discord ("content") and generic JSON receivers (event + details).
 */
export class Notifier {
  private readonly lastAgentStatus = new Map<string, AgentStatus>();

  constructor(
    private readonly settings: SettingsService,
    private readonly store: Store,
    bus: EventBus,
    private readonly publicUrl: string | undefined,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {
    bus.subscribe((event) => {
      if (event.type !== 'agent.updated') return;
      const { agent } = event;
      const previous = this.lastAgentStatus.get(agent.id);
      this.lastAgentStatus.set(agent.id, agent.status);
      if (agent.status === 'blocked' && previous !== undefined && previous !== 'blocked') {
        const sandbox = this.store.sandbox(agent.sandboxId);
        this.notify('agent.blocked', 'notify.agentBlocked', { kind: agent.kind, sandbox: sandbox?.name ?? agent.sandboxId }, `/agents/${agent.id}`);
      }
    });
  }

  /** Fire-and-forget notification if the event is enabled. */
  notify(event: NotificationEvent, key: MessageKey, params: Params, path?: string): void {
    const { webhookUrl, events } = this.settings.get().notifications;
    if (!webhookUrl || !events.includes(event)) return;
    // Notifications always use the server's default language, whoever triggered them.
    void this.post(webhookUrl, event, t(key, params, this.settings.get().general.language), path).catch((err) => this.log(`notification ${event} failed`, err));
  }

  async test(webhookUrl?: string): Promise<MethodResult<'notifications.test'>> {
    const url = webhookUrl ?? this.settings.get().notifications.webhookUrl;
    if (!url) return { ok: false, message: t('notify.noWebhook') };
    try {
      const status = await this.post(url, 'test', t('notify.test', {}, this.settings.get().general.language));
      return status < 300 ? { ok: true, status, message: t('notify.sent') } : { ok: false, status, message: t('notify.httpError', { status }) };
    } catch (err) {
      return { ok: false, message: t('provider.unreachable', { error: (err as Error).message }) };
    }
  }

  private async post(url: string, event: string, message: string, path?: string): Promise<number> {
    const link = path && this.publicUrl ? `${this.publicUrl.replace(/\/$/, '')}${path}` : undefined;
    const text = link ? `${message}\n${link}` : message;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text, event, url: link }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  }
}
