import { PROJECT_VIEW_DATA_KEYS } from "../compat.js";
import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyScript } from "./page.js";
import { canonicalProjectJSON, editProjectValue, projectJSONValue } from "./revision.js";
import type { KeyedRevisionFingerprint } from "./revision.js";

export interface RendererReceipt {
  receiptVersion: 1;
  mutationId: string;
  projectPath: string;
  requestFingerprint: string;
  phase: "preparing" | "saving" | "complete";
  status?: "notApplied" | "applied" | "partial" | "unknown";
  reason?: string;
  before?: Record<string, unknown>;
  beforeGeneration?: number;
  after?: Record<string, unknown>;
  afterGeneration?: number;
  results?: unknown[];
  failedAt?: number;
  saved?: boolean;
  saveFailed?: boolean;
  saveOutcome?: "fulfilled" | "unknown" | "notSent";
  saveReason?: string;
  saveId?: string;
  instanceId?: string;
  startedAtMs?: number;
  errorCode?: string;
  persisted?: boolean;
}

export interface MutationReceipt {
  receiptVersion: 1;
  mutationId: string;
  projectPath: string;
  requestFingerprint: string;
  phase: RendererReceipt["phase"];
  status?: RendererReceipt["status"];
  reason?: string;
  beforeFingerprint?: KeyedRevisionFingerprint;
  beforeGeneration?: number;
  afterFingerprint?: KeyedRevisionFingerprint;
  afterGeneration?: number;
  results?: unknown[];
  failedAt?: number;
  saved?: boolean;
  saveFailed?: boolean;
  saveOutcome?: RendererReceipt["saveOutcome"];
  saveReason?: string;
  saveId?: string;
  instanceId?: string;
  startedAtMs?: number;
  errorCode?: string;
}

export interface MutationIntent {
  intentVersion: 1;
  mutationId: string;
  projectPath: string;
  requestFingerprint: string;
  expectedFingerprint: KeyedRevisionFingerprint;
}

export interface UnresolvedMutation {
  phase: "unresolved" | "awaitingReceipt";
  status: "unknown";
  reason: "receiptAbsent" | "rendererUnavailable";
  retryable: boolean;
  mutationId: string;
  projectPath: string;
  expectedFingerprint: KeyedRevisionFingerprint;
}

export class RendererReceiptUnavailable extends Error {}

export function unresolvedMutation(
  intent: MutationIntent,
  reason: UnresolvedMutation["reason"] = "receiptAbsent",
): UnresolvedMutation {
  return {
    phase: reason === "rendererUnavailable" ? "awaitingReceipt" : "unresolved",
    status: "unknown",
    reason,
    retryable: reason === "rendererUnavailable",
    mutationId: intent.mutationId,
    projectPath: intent.projectPath,
    expectedFingerprint: intent.expectedFingerprint,
  };
}

export async function readMutationIntent(path: string): Promise<MutationIntent | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Mutation intent is not a regular private-state file.");
  const intent: MutationIntent = JSON.parse(await readFile(path, "utf8"));
  if (intent.intentVersion !== 1 || !intent.expectedFingerprint || !intent.requestFingerprint)
    throw new Error("Mutation intent is invalid; reconcile it before continuing.");
  return intent;
}

export function sameRevisionFingerprint(a: KeyedRevisionFingerprint, b: KeyedRevisionFingerprint) {
  return (
    a.version === b.version && a.algorithm === b.algorithm && a.keyId === b.keyId && a.sha256 === b.sha256
  );
}

export async function readMutationReceipt(path: string): Promise<MutationReceipt | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Mutation receipt is not a regular private-state file.");
  const receipt: MutationReceipt = JSON.parse(await readFile(path, "utf8"));
  if (
    receipt.receiptVersion !== 1 ||
    receipt.phase !== "complete" ||
    (!receipt.beforeFingerprint && receipt.status !== "notApplied")
  )
    throw new Error("Mutation receipt is incomplete; inspect and reconcile it before continuing.");
  return receipt;
}

async function publishMutationFile(path: string, content: string): Promise<boolean> {
  const temporary = join(dirname(path), `.mutation-${randomUUID()}.tmp`);
  let created = true;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      created = false;
    }
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return created;
}

export async function reserveMutationIntent(path: string, intent: MutationIntent) {
  const created = await publishMutationFile(path, JSON.stringify(intent));
  if (!created) {
    const previous = await readMutationIntent(path);
    if (
      !previous ||
      previous.mutationId !== intent.mutationId ||
      previous.projectPath !== intent.projectPath ||
      previous.requestFingerprint !== intent.requestFingerprint ||
      !sameRevisionFingerprint(previous.expectedFingerprint, intent.expectedFingerprint)
    )
      throw new Error("Mutation ID already belongs to a different request; nothing was retried.");
  }
  return created;
}

export async function persistMutationReceipt(path: string, receipt: MutationReceipt) {
  if (receipt.phase !== "complete") return;
  const created = await publishMutationFile(path, JSON.stringify(receipt));
  if (!created && JSON.stringify(await readMutationReceipt(path)) !== JSON.stringify(receipt))
    throw new Error("Mutation receipt already has different evidence; both states require reconciliation.");
}

export interface NativeMutation {
  mutationId: string;
  requestFingerprint: string;
  expectedSha256: string;
  save: boolean;
}

/** The guarded batch is synchronous; only hashing and saving may yield. */
export function transactionScript(
  path: string,
  sceneId: string,
  prepared: unknown[],
  mutation: NativeMutation,
) {
  const j = JSON.stringify;
  return `
    const path = ${j(path)};
    const id = ${j(mutation.mutationId)};
    const requestFingerprint = ${j(mutation.requestFingerprint)};
    const receipts = window.__ssmcpRevisionReceipts ??= {};
    if (Object.hasOwn(receipts, id)) {
      const previous = receipts[id];
      if (previous.projectPath !== path || previous.requestFingerprint !== requestFingerprint)
        throw new Error('Mutation ID already belongs to a different request; nothing was retried.');
      return { phase: previous.phase, status: previous.status, persisted: previous.persisted };
    }
    const receipt = { receiptVersion: 1, mutationId: id, projectPath: path, requestFingerprint, phase: 'preparing' };
    receipts[id] = receipt;
    const busy = { since: Date.now(), kind: 'edit', mutationId: id };
    const refuse = (reason) => { Object.assign(receipt, { status: 'notApplied', reason, phase: 'complete' }); return { phase: receipt.phase, status: receipt.status }; };
    let started = false;
    try {
      let c;
      try { c = __ss.get(path); } catch { return refuse('projectNotOpen'); }
      const projectModel = c.project;
      const PROJECT_VIEW_DATA_KEYS = ${j(PROJECT_VIEW_DATA_KEYS)};
      const projectJSONValue = ${projectJSONValue.toString()};
      const editProjectValue = ${editProjectValue.toString()};
      const canonicalProjectJSON = ${canonicalProjectJSON.toString()};
      const canonical = (project) => canonicalProjectJSON(editProjectValue(project));
      const before = projectJSONValue(c.project.serialize());
      const beforeGeneration = c.project.editGeneration;
      const beforeJSON = canonical(before);
      Object.assign(receipt, { before, beforeGeneration });
      if (__ss.busy()[path]) return refuse(__ss.busy()[path].kind === 'pendingWrite' ? 'writeQuarantined' : 'editorBusy');
      __ss.busy()[path] = busy;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(beforeJSON));
      const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (__ss.get(path) !== c || c.project !== projectModel || sha256 !== ${j(mutation.expectedSha256)} || canonical(c.project.serialize()) !== beforeJSON) {
        return refuse('baseMismatch');
      }
      // No await occurs between this content check and the captured post-state.
      delete __ss.busy()[path];
      started = true;
      const result = (() => { ${applyScript(path, sceneId, prepared, undefined, undefined, true)} })();
      const nativeAfter = structuredClone(c.project.serialize());
      receipt.after = projectJSONValue(nativeAfter);
      receipt.afterGeneration = c.project.editGeneration;
      receipt.results = result.results;
      receipt.status = result.failedAt === undefined ? 'applied' : 'partial';
      if (result.failedAt !== undefined) {
        receipt.failedAt = result.failedAt;
        receipt.reason = 'operationFailed';
        receipt.errorCode = /did not keep the requested value/.test(result.error) ? 'valueNotKept' : /overlap/.test(result.error) ? 'rangeOverlap' : /does not exist/.test(result.error) ? 'notFound' : 'operationFailed';
      }
      receipt.saved = false;
      __ss.busy()[path] = busy;
      if (${j(mutation.save)} && receipt.status === 'applied') {
        receipt.phase = 'saving';
        let saved;
        try { saved = await __ssSave(c, nativeAfter, receipt.afterGeneration, busy, id); }
        catch { saved = { saved: false, saveOutcome: busy.kind === 'pendingWrite' ? 'unknown' : 'notSent', saveReason: 'saveHelperFailed',
          ...(busy.kind === 'pendingWrite' ? { saveId: id, instanceId: window.__ssmcpRendererInstance,
            startedAtMs: window.__ssmcpPendingWrites?.[id]?.startedAtMs } : {}) }; }
        receipt.saved = saved.saved;
        receipt.saveOutcome = saved.saveOutcome;
        if (saved.saveReason) receipt.saveReason = saved.saveReason;
        if (saved.saveId) receipt.saveId = saved.saveId;
        if (saved.instanceId) receipt.instanceId = saved.instanceId;
        if (saved.startedAtMs !== undefined) receipt.startedAtMs = saved.startedAtMs;
        if (!saved.saved) receipt.saveFailed = true;
      }
      receipt.phase = 'complete';
      return { phase: receipt.phase, status: receipt.status };
    } catch {
      receipt.status = started ? 'unknown' : 'notApplied';
      receipt.reason = started ? 'captureFailed' : 'captureRefused';
      receipt.phase = 'complete';
      return { phase: receipt.phase, status: receipt.status };
    } finally {
      if (__ss.busy()[path] === busy && busy.kind !== 'pendingWrite') delete __ss.busy()[path];
    }
  `;
}
