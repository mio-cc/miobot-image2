import type { AgentMessage, AgentSessionState, AgentTurnInput } from './types.js';

export interface AgentSessionStore {
  load(sessionKey: string): AgentSessionState | undefined;
  loadOrCreate?(input: { sessionKey: string; turnId: string; configRevision: string; runtimeVersion: string }): AgentSessionState;
  save(state: AgentSessionState): AgentSessionState;
  delete(sessionKey: string): boolean;
  listSessionKeys(): string[];
}

export interface AgentSessionManagerOptions {
  defaultRuntimeVersion?: string;
  clock?: () => Date;
  initialSessions?: AgentSessionState[];
  persist?: (sessions: AgentSessionState[]) => void;
  getLimits?: () => AgentSessionLimits;
  maxSessions?: number;
  maxMessagesPerSession?: number;
  maxCharsPerSession?: number;
  ttlMs?: number;
}

export interface LoadOrCreateSessionInput {
  sessionKey: string;
  turnId: string;
  configRevision: string;
  runtimeVersion: string;
}

export interface AgentSessionLimits {
  maxSessions?: number;
  maxMessagesPerSession?: number;
  maxCharsPerSession?: number;
  ttlMs?: number;
}

const DEFAULT_SESSION_LIMITS: Required<AgentSessionLimits> = {
  maxSessions: 2_000,
  maxMessagesPerSession: 200,
  maxCharsPerSession: 120_000,
  ttlMs: 0,
};

export class InMemoryAgentSessionManager implements AgentSessionStore {
  private readonly sessions = new Map<string, AgentSessionState>();
  private readonly defaultRuntimeVersion: string;
  private readonly clock: () => Date;
  private readonly persist?: (sessions: AgentSessionState[]) => void;
  private readonly getLimits?: () => AgentSessionLimits;
  private readonly defaultLimits: AgentSessionLimits;

  constructor(options: AgentSessionManagerOptions = {}) {
    this.defaultRuntimeVersion = String(options.defaultRuntimeVersion || 'r1-contract');
    this.clock = options.clock || (() => new Date());
    this.persist = options.persist;
    this.getLimits = options.getLimits;
    this.defaultLimits = {
      maxSessions: options.maxSessions,
      maxMessagesPerSession: options.maxMessagesPerSession,
      maxCharsPerSession: options.maxCharsPerSession,
      ttlMs: options.ttlMs,
    };
    for (const state of options.initialSessions || []) {
      if (state?.sessionKey) this.sessions.set(String(state.sessionKey), cloneSession(state));
    }
    this.prune();
  }

  load(sessionKey: string): AgentSessionState | undefined {
    const key = String(sessionKey);
    const state = this.sessions.get(key);
    if (!state) return undefined;
    if (this.isExpired(state) && !this.hasPendingWork(state)) {
      this.sessions.delete(key);
      this.flush();
      return undefined;
    }
    return cloneSession(state);
  }

  loadOrCreate(input: LoadOrCreateSessionInput): AgentSessionState {
    this.prune();
    const key = String(input.sessionKey || '').trim();
    if (!key) throw new Error('sessionKey is required');
    const existing = this.sessions.get(key);
    if (existing) {
      const next = cloneSession(existing);
      next.turnId = String(input.turnId || next.turnId);
      next.configRevision = String(input.configRevision || next.configRevision);
      next.runtimeVersion = String(input.runtimeVersion || next.runtimeVersion || this.defaultRuntimeVersion);
      next.updatedAt = this.now();
      this.sessions.set(key, cloneSession(next));
      this.prune();
      this.flush();
      return this.load(key)!;
    }
    const now = this.now();
    const created: AgentSessionState = {
      sessionKey: key,
      turnId: String(input.turnId || ''),
      messages: [],
      pinnedFacts: {},
      artifacts: [],
      configRevision: String(input.configRevision || ''),
      runtimeVersion: String(input.runtimeVersion || this.defaultRuntimeVersion),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, cloneSession(created));
    this.prune();
    this.flush();
    return this.load(key)!;
  }

  save(state: AgentSessionState): AgentSessionState {
    const key = String(state?.sessionKey || '').trim();
    if (!key) throw new Error('sessionKey is required');
    const next = cloneSession({ ...state, sessionKey: key, updatedAt: this.now() });
    this.sessions.set(key, next);
    this.prune();
    this.flush();
    return cloneSession(this.sessions.get(key) || next);
  }

  appendMessages(sessionKey: string, messages: AgentMessage[]): AgentSessionState {
    const state = this.sessions.get(String(sessionKey));
    if (!state) throw new Error(`agent_session_not_found:${sessionKey}`);
    state.messages.push(...messages.map((message) => structuredClone(message)));
    state.updatedAt = this.now();
    this.prune();
    this.flush();
    return cloneSession(this.sessions.get(String(sessionKey)) || state);
  }

  delete(sessionKey: string): boolean {
    const removed = this.sessions.delete(String(sessionKey));
    if (removed) this.flush();
    return removed;
  }

  clearAll(): void {
    this.sessions.clear();
    this.flush();
  }

  listSessionKeys(): string[] {
    this.prune();
    return [...this.sessions.keys()];
  }

  snapshot(): AgentSessionState[] {
    return [...this.sessions.values()].map(cloneSession);
  }

  private effectiveLimits(): Required<AgentSessionLimits> {
    const raw = { ...this.defaultLimits, ...(this.getLimits?.() || {}) };
    return {
      maxSessions: Math.max(1, Math.trunc(Number(raw.maxSessions) || DEFAULT_SESSION_LIMITS.maxSessions)),
      maxMessagesPerSession: Math.max(1, Math.trunc(Number(raw.maxMessagesPerSession) || DEFAULT_SESSION_LIMITS.maxMessagesPerSession)),
      maxCharsPerSession: Math.max(1, Math.trunc(Number(raw.maxCharsPerSession) || DEFAULT_SESSION_LIMITS.maxCharsPerSession)),
      ttlMs: Math.max(0, Math.trunc(Number(raw.ttlMs) || 0)),
    };
  }

  private isExpired(state: AgentSessionState): boolean {
    const ttlMs = this.effectiveLimits().ttlMs;
    if (!ttlMs) return false;
    const updatedAt = Date.parse(String(state.updatedAt || ''));
    return Number.isFinite(updatedAt) && this.clock().getTime() - updatedAt > ttlMs;
  }

  private hasPendingWork(state: AgentSessionState): boolean {
    return Boolean(state.pendingQuestion || state.pendingToolCalls?.length || state.pendingApprovals?.length || state.pendingJobs?.length);
  }

  private trimMessages(state: AgentSessionState, limits: Required<AgentSessionLimits>): void {
    if (!Array.isArray(state.messages)) state.messages = [];
    if (state.messages.length > limits.maxMessagesPerSession) {
      state.messages = state.messages.slice(-limits.maxMessagesPerSession);
    }
    let total = state.messages.reduce((sum, message) => sum + String(message?.content || '').length, 0);
    while (state.messages.length > 1 && total > limits.maxCharsPerSession) {
      const removed = state.messages.shift();
      total -= String(removed?.content || '').length;
    }
  }

  private prune(): void {
    const limits = this.effectiveLimits();
    for (const [key, state] of this.sessions) {
      if (this.isExpired(state) && !this.hasPendingWork(state)) {
        this.sessions.delete(key);
        continue;
      }
      if (!this.hasPendingWork(state)) this.trimMessages(state, limits);
    }
    if (this.sessions.size <= limits.maxSessions) return;
    const ordered = [...this.sessions.values()].sort((a, b) => {
      const pendingDiff = Number(this.hasPendingWork(b)) - Number(this.hasPendingWork(a));
      if (pendingDiff !== 0) return pendingDiff;
      return Date.parse(String(b.updatedAt || '')) - Date.parse(String(a.updatedAt || ''));
    });
    this.sessions.clear();
    for (const state of ordered.slice(0, limits.maxSessions)) this.sessions.set(state.sessionKey, state);
  }

  private flush(): void {
    try {
      this.persist?.(this.snapshot());
    } catch { /* persistence must never break a turn */ }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export function createAgentSessionManager(options: AgentSessionManagerOptions = {}): InMemoryAgentSessionManager {
  return new InMemoryAgentSessionManager(options);
}

function cloneSession(state: AgentSessionState): AgentSessionState {
  return structuredClone(state);
}
