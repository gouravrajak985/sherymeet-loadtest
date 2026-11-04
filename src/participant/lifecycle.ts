export const PARTICIPANT_STATES = [
  "pending",
  "launching",
  "loading",
  "authenticating",
  "joining",
  "connected",
  "interacting",
  "reconnecting",
  "leaving",
  "completed",
  "failed",
] as const;

export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export interface Transition {
  from: ParticipantState;
  to: ParticipantState;
  at: string;
  detail?: string;
}

const NEXT: Record<ParticipantState, readonly ParticipantState[]> = {
  pending: ["launching"],
  launching: ["loading"],
  loading: ["authenticating"],
  authenticating: ["joining"],
  joining: ["connected"],
  connected: ["interacting", "reconnecting", "leaving"],
  interacting: ["reconnecting", "leaving"],
  reconnecting: ["interacting", "leaving"],
  leaving: ["completed"],
  completed: [],
  failed: [],
};

const TERMINAL = new Set<ParticipantState>(["completed", "failed"]);

/** Enforces the participant state machine and records every transition. */
export class Lifecycle {
  private current: ParticipantState = "pending";
  readonly transitions: Transition[] = [];

  constructor(private readonly onTransition?: (transition: Transition) => void) {}

  get state(): ParticipantState {
    return this.current;
  }

  get isTerminal(): boolean {
    return TERMINAL.has(this.current);
  }

  to(next: ParticipantState, detail?: string): void {
    const allowed =
      next === "failed" ? !this.isTerminal : NEXT[this.current].includes(next);
    if (!allowed) {
      throw new Error(`Illegal participant transition ${this.current} -> ${next}`);
    }
    const transition: Transition = {
      from: this.current,
      to: next,
      at: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    };
    this.current = next;
    this.transitions.push(transition);
    this.onTransition?.(transition);
  }
}
