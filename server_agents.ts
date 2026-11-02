/**
 * Shared, local-only coordination for JARVIS's logical agents.  Models select a
 * typed tool; this layer owns serialization, cancellation, target scope and
 * approvals before an executor receives the action.
 */
export type AgentName = "orchestrator" | "browser" | "desktop" | "files" | "coding" | "system" | "verification";

export interface SharedTaskState {
  objective: string;
  activeTargets: Record<string, string>;
  completedSteps: string[];
  pendingAction?: { id: string; summary: string; expiresAt: number };
  cancelled: boolean;
}

export interface GateResult {
  allowed: boolean;
  operationId: string;
  message?: string;
}

const destructiveTools = new Set(["browserClose", "fileOperation", "systemCommand"]);
const locks = new Map<string, Promise<void>>();
const state: SharedTaskState = { objective: "", activeTargets: {}, completedSteps: [], cancelled: false };

function id() { return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }

export function responsibleAgent(tool: string): AgentName {
  if (tool.startsWith("browser")) return "browser";
  if (tool.startsWith("desktop")) return "desktop";
  if (tool === "fileOperation") return "files";
  if (tool === "codeOperation") return "coding";
  if (tool === "systemCommand" || tool === "systemControl") return "system";
  return "orchestrator";
}

export function requiresConfirmation(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "browserClose") return true;
  if (tool === "desktopAppControl" && args.action === "close") return true;
  if (tool === "fileOperation" && ["move_to_trash", "delete", "overwrite"].includes(String(args.operation))) return true;
  if (tool === "systemCommand") return Boolean(args.destructive || args.privileged || args.external);
  return destructiveTools.has(tool) && Boolean(args.destructive);
}

export function gateOperation(tool: string, args: Record<string, unknown>): GateResult {
  const operationId = id();
  if (requiresConfirmation(tool, args)) {
    const target = String(args.path || args.appName || args.scope || args.command || "the requested target");
    const summary = `${tool} on ${target}`;
    state.pendingAction = { id: operationId, summary, expiresAt: Date.now() + 60_000 };
    return { allowed: false, operationId, message: `Confirmation required for ${summary}. Ask the user to confirm this exact action.` };
  }
  return { allowed: true, operationId };
}

export function approveOperation(operationId: string): GateResult {
  const pending = state.pendingAction;
  if (!pending || pending.id !== operationId || pending.expiresAt < Date.now()) {
    state.pendingAction = undefined;
    return { allowed: false, operationId, message: "That confirmation has expired or does not match the pending action." };
  }
  state.pendingAction = undefined;
  return { allowed: true, operationId };
}

export function cancelActiveTask(): void {
  state.cancelled = true;
  state.pendingAction = undefined;
}

export function beginTask(objective: string): void {
  state.objective = objective;
  state.cancelled = false;
}

export function completeStep(summary: string, targets: Record<string, string> = {}): void {
  state.completedSteps = [summary, ...state.completedSteps].slice(0, 30);
  state.activeTargets = { ...state.activeTargets, ...targets };
}

/** The verification agent accepts only observed executor state, never a tool-call acknowledgement. */
export function verifyAgentResult(verification: unknown): { verified: boolean; reason?: string } {
  if (!verification || typeof verification !== "object") return { verified: false, reason: "The executor returned no observed result." };
  const observed = verification as Record<string, unknown>;
  if (observed.loaded === false) return { verified: false, reason: "The browser did not reach the requested destination." };
  if (observed.exists === false) return { verified: false, reason: "The requested path does not exist after the operation." };
  if (observed.contentMatches === false) return { verified: false, reason: "The saved file does not contain the requested text." };
  return { verified: true };
}

/** Serialize conflicting target operations while allowing unrelated agents to run. */
export async function withTargetLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(target) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => { release = resolve; });
  locks.set(target, previous.then(() => own));
  await previous;
  try {
    if (state.cancelled) throw new Error("The current JARVIS task was cancelled.");
    return await operation();
  } finally {
    release();
    if (locks.get(target) === own) locks.delete(target);
  }
}

export function snapshotTaskState(): SharedTaskState {
  return structuredClone(state);
}
