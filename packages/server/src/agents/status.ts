import { createHash } from 'node:crypto';
import type { Agent, AgentProfile, AgentStatus } from '@cocoon/protocol';

const TAIL_LINES = 15;
/** A question only counts as blocking while it is at the very bottom of the screen. */
const PROMPT_LINES = 6;
const REPORTABLE = new Set<AgentStatus>(['working', 'blocked', 'done', 'idle']);
/** A hook "working" report is distrusted once the screen has been quiet this long (e.g. API error, no Stop hook). */
const STALE_WORKING_MS = 15_000;

export interface Observation {
  status: Exclude<AgentStatus, 'exited' | 'unknown'>;
  source: Agent['statusSource'];
}

/**
 * Determines an agent's status. Hook reports written by the agent CLI itself win;
 * otherwise herdr-style heuristics on periodic screen snapshots are used:
 * changing screen → working; quiet + permission prompt visible → blocked;
 * quiet after work that was requested via prompt/input → done; otherwise idle.
 */
export class StatusDetector {
  private lastHash = '';
  private lastChangeAt = 0;
  private sawWork = false;
  private lastReported = '';
  private lastLines: string[] = [];
  /** Screen lines visible when the user last answered; a question on them has been dealt with. */
  private answeredLines = new Set<string>();
  /** Hook report seen when the current task started; older reports are ignored. */
  private reportAtArm = '';
  private readonly working: RegExp[];
  private readonly blocked: RegExp[];
  private readonly idleForeground?: Set<string>;
  private readonly useHooks: boolean;

  /** True while a task (prompt / input) is outstanding; quiet afterwards means "done". */
  private armed: boolean;

  private firstObservation = true;

  /**
   * @param restored status of an agent that was already running before a server restart: the first snapshot and any
   *   existing hook report are treated as already known, and the status is kept until something actually changes.
   */
  constructor(
    profile: AgentProfile,
    armed: boolean,
    private readonly idleAfterMs: number,
    private readonly restored?: AgentStatus,
  ) {
    this.working = profile.workingPatterns.map((p) => new RegExp(p, 'i'));
    this.blocked = profile.blockedPatterns.map((p) => new RegExp(p, 'i'));
    this.idleForeground = profile.idleForeground && new Set(profile.idleForeground);
    this.useHooks = Boolean(profile.hooks);
    this.armed = armed;
  }

  /** Call after sending input so the next quiet period is reported as "done". */
  arm(now = Date.now()): void {
    this.armed = true;
    this.sawWork = false;
    this.lastChangeAt = now;
    this.reportAtArm = this.lastReported;
    this.answeredLines = new Set(this.lastLines);
  }

  observe(screen: string, foreground: string, reported: string, now = Date.now()): Observation {
    this.lastReported = reported;
    const hash = createHash('sha1').update(screen).digest('hex');
    if (this.firstObservation && this.restored) {
      this.lastHash = hash;
      this.reportAtArm = reported;
    }
    this.firstObservation = false;
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.lastChangeAt = now;
    }

    const heuristic = this.heuristic(screen, foreground, now);
    if (this.useHooks && reported && reported !== this.reportAtArm) {
      const status = reported.split(' ')[0] as AgentStatus;
      const stale = status === 'working' && heuristic !== 'working' && now - this.lastChangeAt > STALE_WORKING_MS;
      if (REPORTABLE.has(status) && !stale) return { status: status as Observation['status'], source: 'hook' };
    }
    return { status: heuristic, source: 'heuristic' };
  }

  private heuristic(screen: string, foreground: string, now: number): Observation['status'] {
    const lines = screen.trimEnd().split('\n');
    this.lastLines = lines;
    const tail = lines.slice(-TAIL_LINES).join('\n');
    const bottom = lines
      .filter((line) => line.trim())
      .slice(-PROMPT_LINES)
      .filter((line) => !this.answeredLines.has(line))
      .join('\n');
    const quiet = now - this.lastChangeAt >= this.idleAfterMs;

    if (!quiet || this.working.some((re) => re.test(tail))) {
      this.sawWork = true;
      return 'working';
    }
    if (this.blocked.some((re) => re.test(bottom))) return 'blocked';
    if (this.idleForeground && foreground !== '' && !this.idleForeground.has(foreground)) {
      this.sawWork = true;
      return 'working';
    }
    if (this.armed && this.sawWork) return 'done';
    if (!this.sawWork && (this.restored === 'done' || this.restored === 'blocked')) return this.restored;
    return 'idle';
  }
}
