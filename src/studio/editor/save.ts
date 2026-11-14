import { PROJECT_VIEW_DATA_KEYS, projectSaveAcknowledged } from "../compat.js";
import { canonicalProjectJSON, editProjectValue, projectJSONValue } from "./revision.js";

export interface SaveOutcome {
  saved: boolean;
  saveOutcome: "fulfilled" | "unknown" | "notSent";
  saveReason?: string;
  saveId?: string;
  instanceId?: string;
  startedAtMs?: number;
  writeQuarantine?: { saveId: string; since: number; instanceId?: string; phase: string } | null;
  unsavedChanges?: boolean;
}

const CANONICAL = `
  const PROJECT_VIEW_DATA_KEYS = ${JSON.stringify(PROJECT_VIEW_DATA_KEYS)};
  const projectJSONValue = ${projectJSONValue.toString()};
  const editProjectValue = ${editProjectValue.toString()};
  const canonicalProjectJSON = ${canonicalProjectJSON.toString()};
  const canonical = (value) => canonicalProjectJSON(editProjectValue(value));
`;

/** Native completion can outlive the CDP call; its barrier must survive that call too. */
export const GUARDED_SAVE = `
const __ssSave = async (c, data, generation, barrier, saveId, deadlineMs = 45000) => {
  const path = c.project.path;
  const project = c.project;
  ${CANONICAL}
  const expected = canonical(data);
  const current = () => {
    try {
      return __ss.get(path) === c && c.project === project &&
        project.editGeneration === generation && canonical(project.serialize()) === expected;
    } catch { return false; }
  };
  if (__ss.busy()[path] !== barrier || !current())
    return { saved: false, saveOutcome: 'notSent', saveReason: 'projectChanged' };
  const pending = window.__ssmcpPendingWrites ??= {};
  if (Object.hasOwn(pending, saveId)) throw new Error('Save ID already has an observation.');
  const instanceId = __ss.instanceId;
  const observation = {
    saveId, projectPath: path, instanceId, startedAtMs: Date.now(), phase: 'pending'
  };
  pending[saveId] = observation;
  barrier.kind = 'pendingWrite';
  barrier.saveId = saveId;
  let timer;
  const finish = (fulfilled, reason) => {
    observation.phase = fulfilled ? 'fulfilled' : reason === 'unexpectedNativeResult' ? 'unconfirmed' : 'rejected';
    observation.settledAtMs = Date.now();
    if (!fulfilled) observation.saveReason = reason ?? (observation.dispatchThrew ? 'dispatchThrew' : 'nativeRejected');
    if (fulfilled) {
      observation.diverged = !current();
      observation.cleanMarked = false;
      if (!observation.diverged) {
        try { project.markAsJustSaved(generation); observation.cleanMarked = true; }
        catch { observation.cleanMarked = false; }
      }
      if (__ss.busy()[path] === barrier) delete __ss.busy()[path];
    }
    return { saved: fulfilled, saveOutcome: fulfilled ? 'fulfilled' : 'unknown',
      ...(fulfilled ? {} : { saveReason: observation.saveReason }), saveId,
      instanceId, startedAtMs: observation.startedAtMs };
  };
  let native;
  try { native = bridge.client.mutation('project.updateProject', { projectPath: path, data }); }
  catch { observation.dispatchThrew = true; native = Promise.reject(new Error('Native save dispatch failed.')); }
  const projectSaveAcknowledged = ${projectSaveAcknowledged.toString()};
  const completion = Promise.resolve(native).then(value => projectSaveAcknowledged(value) ? finish(true) : finish(false, 'unexpectedNativeResult'), () => finish(false));
  try {
    const outcome = await Promise.race([
      completion,
      new Promise(resolve => { timer = setTimeout(() => resolve({
        saved: false, saveOutcome: 'unknown', saveReason: 'deadline', saveId,
        instanceId, startedAtMs: observation.startedAtMs
      }), deadlineMs); })
    ]);
    return { ...outcome, unsavedChanges: project.isDirty };
  } finally { clearTimeout(timer); }
};
`;

/** Rechecks the captured save in the same renderer turn that closes its editor. */
// Closing the window can destroy the page context before the script's result is delivered, which loses the
// reply ("Promise was collected"). The window closes on a timer so the result goes out first. The busy
// barrier is held until then, and a project edited by hand in the meantime is left open.
const CLOSE_AFTER_REPLY = `
      const closingGeneration = project.editGeneration;
      setTimeout(() => {
        try {
          if (__ss.get(path) === c && c.project === project && project.editGeneration === closingGeneration) {
            w.onbeforeunload = null;
            w.close();
          }
        } finally {
          if (__ss.busy()[path] === barrier) delete __ss.busy()[path];
        }
      }, 100);`;

export function closeSavedScript(path: string, saveId: string) {
  return `
    const path = ${JSON.stringify(path)};
    const c = __ss.edit(path);
    const project = c.project;
    const generation = project.editGeneration;
    const data = structuredClone(project.serialize());
    ${CANONICAL}
    const expected = canonical(data);
    const barrier = { since: Date.now(), kind: 'edit' };
    __ss.busy()[path] = barrier;
    let closing = false;
    try {
      const outcome = await __ssSave(c, data, generation, barrier, ${JSON.stringify(saveId)});
      if (!outcome.saved)
        throw new Error(outcome.saveOutcome === 'notSent'
          ? 'The project changed before save dispatch; the editor was left open.'
          : 'The native save has not completed; the editor was left open. Inspect saveId ' + outcome.saveId + ', instanceId ' + outcome.instanceId + ', startedAtMs ' + outcome.startedAtMs + ' before closing.');
      if (__ss.edit(path) !== c || c.project !== project || project.isDirty ||
          project.editGeneration !== generation || canonical(project.serialize()) !== expected)
        throw new Error('The project changed while saving; the editor was left open to preserve those edits.');
      const w = c.view?.targetWindow;
      if (!w) throw new Error('The saved editor window is unavailable; it was not closed.');
      if (__ss.busy()[path] && __ss.busy()[path] !== barrier)
        throw new Error('Another operation started on the project; the editor was left open.');
      barrier.kind = 'edit';
      __ss.busy()[path] = barrier;
      closing = true;
      ${CLOSE_AFTER_REPLY}
      return { saved: true };
    } finally {
      if (!closing && __ss.busy()[path] === barrier && barrier.kind !== 'pendingWrite') delete __ss.busy()[path];
    }
  `;
}

export function closeWithoutSaveScript(path: string, expectedSha256?: string) {
  return `
    const path = ${JSON.stringify(path)};
    const c = __ss.edit(path);
    const project = c.project;
    const generation = project.editGeneration;
    const barrier = { since: Date.now(), kind: 'edit' };
    __ss.busy()[path] = barrier;
    let closing = false;
    try {
      const expectedSha256 = ${JSON.stringify(expectedSha256) ?? "undefined"};
      if (expectedSha256) {
        ${CANONICAL}
        const before = canonical(project.serialize());
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(before));
        const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (__ss.get(path) !== c || c.project !== project || __ss.busy()[path] !== barrier ||
            project.editGeneration !== generation || actual !== expectedSha256 || canonical(project.serialize()) !== before)
          throw new Error('The project changed since the discard snapshot; nothing was closed or discarded.');
      } else if (project.isDirty) {
        throw new Error('The project has unsaved edits. Save it, or explicitly discard using its current snapshot fingerprint.');
      }
      const w = c.view?.targetWindow;
      if (!w) throw new Error('The editor window is unavailable; it was not closed.');
      if (expectedSha256) project.markAsJustSaved(generation);
      closing = true;
      ${CLOSE_AFTER_REPLY}
      return true;
    } finally { if (!closing && __ss.busy()[path] === barrier) delete __ss.busy()[path]; }
  `;
}
