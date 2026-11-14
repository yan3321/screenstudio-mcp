// Edits happen in Screen Studio's open editor window, through the same model the
// UI uses: changes appear live, land in the app's undo history, and save the way
// Cmd+S does. Nothing rewrites project files behind the editor's back.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CommandNotSentError } from "../../cdp/client.js";
import type { Studio } from "../service.js";
import { Desktop } from "../desktop.js";
import { APP_BUILD, editorWindowTitle } from "../compat.js";
import { captureWindow, cropPng, exec } from "../media.js";
import { readRecordingMeta } from "../recording.js";
import { round } from "../timeline.js";
import { assertProjectBundle, projectEditFingerprint } from "../project.js";
import { assertUuid } from "../util.js";
import { describeScene } from "./describe.js";
import {
  editProjectValue,
  revisionFingerprint,
  keyedEditRevisionFingerprint,
  keyedRevisionFingerprint,
  projectJSONValue,
  publicSnapshot,
  canonicalProjectJSON,
} from "./revision.js";
import type { KeyedRevisionFingerprint } from "./revision.js";
import {
  persistMutationReceipt,
  readMutationReceipt,
  readMutationIntent,
  reserveMutationIntent,
  sameRevisionFingerprint,
  transactionScript,
  unresolvedMutation,
  RendererReceiptUnavailable,
} from "./transaction.js";
import type { MutationIntent, MutationReceipt, RendererReceipt } from "./transaction.js";
import { prepareOps, type EditOp } from "./ops.js";
import { PRELUDE, applyScript, previewSeekScript } from "./page.js";
import type { SaveOutcome } from "./save.js";
import { closeSavedScript, closeWithoutSaveScript } from "./save.js";
const j = JSON.stringify;

/** Size of the captured window or display, in the points mask bounds use. */
async function captureSize(projectPath: string) {
  try {
    const b = (await readRecordingMeta(projectPath)).sessions[0].bounds;
    return { width: b.width, height: b.height };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

export class Editor {
  private tails = new Map<string, Promise<unknown>>();
  constructor(
    private studio: Studio,
    private desktop = new Desktop(),
  ) {}

  /**
   * Runs one change to a project after the previous one finishes, so a paced
   * apply is never interleaved with another write, undo or playhead move. Per
   * project rather than Studio.lock, so a long apply never stalls recording or exports.
   */
  private async locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    this.tails.set(path, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(path) === tail) this.tails.delete(path);
    }
  }

  private run<T = any>(body: string, timeout = 30000): Promise<T> {
    return this.studio.evaluate<T>(PRELUDE + body, timeout);
  }

  async list() {
    await this.studio.requireVersion("read");
    return this.run<any[]>(
      `return __ss.contexts().map((c) => ({ projectPath: c.project.path, name: c.project.name, dirty: c.project.isDirty, focused: c === window.$$focused, playbackDurationMs: Math.round(c.project.playbackDurationMs) }));`,
    );
  }

  /** Selects the person's existing editor without opening or copying anything. */
  async current(projectPath?: string) {
    if (projectPath) return this.studio.path(projectPath);
    const editors = await this.list();
    const focused = editors.filter((e) => e.focused);
    if (focused.length === 1) return focused[0].projectPath as string;
    if (editors.length === 1) return editors[0].projectPath as string;
    if (!editors.length) throw new Error("No project is open in Screen Studio. Open the video to edit.");
    throw new Error(
      "Choose the Screen Studio editor to edit; several projects are open and none is focused.",
    );
  }

  async open(projectPath: string) {
    const path = await this.studio.path(projectPath);
    await assertProjectBundle(path);
    await this.studio.requireVersion("read");
    await this.studio.projectLock(path, async () => {
      const already = (await this.list()).some((e) => e.projectPath === path);
      if (!already) {
        await exec("/usr/bin/open", ["-a", this.studio.appPath, path], { timeout: 15000 });
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 250));
          if ((await this.list()).some((e) => e.projectPath === path)) break;
        }
      }
      await this.run(
        `const c = __ss.get(${j(path)}); try { c.view.targetWindow.focus(); } catch {} return true;`,
      ).catch(() => {
        throw new Error("Screen Studio did not open the project editor. Inspect the app before retrying.");
      });
    });
    return this.state(path);
  }

  async close(
    projectPath: string,
    options: { save?: boolean; expectedFingerprint?: KeyedRevisionFingerprint } = {},
  ) {
    const path = await this.studio.path(projectPath);
    await assertProjectBundle(path);
    const version = await this.studio.requireVersion("write");
    return this.locked(path, async () => {
      const open = (await this.list()).some((e) => e.projectPath === path);
      if (!open) return { closed: false, alreadyClosed: true, projectPath: path };
      if (options.save !== false) {
        const saveId = randomUUID();
        try {
          await this.run(closeSavedScript(path, saveId), 60000);
        } catch (error) {
          throw Object.assign(
            new Error(
              `${error instanceof Error ? error.message : "Close save was not confirmed."} Close save requestId ${saveId}; retain this ID and inspect the live editor and save observation before continuing.`,
              { cause: error },
            ),
            { saveId },
          );
        }
      } else {
        let expectedSha256: string | undefined;
        if (options.expectedFingerprint) {
          if (version !== APP_BUILD)
            throw new Error("Fenced discard requires the tested Screen Studio build.");
          const captured = await this.captureSnapshot(path);
          const actual = await keyedEditRevisionFingerprint(
            captured.project,
            await this.studio.statePath("revision-integrity.key"),
          );
          if (!sameRevisionFingerprint(actual, options.expectedFingerprint))
            throw new Error(
              "The project changed since the discard snapshot; nothing was closed or discarded.",
            );
          expectedSha256 = createHash("sha256")
            .update(canonicalProjectJSON(editProjectValue(captured.project)))
            .digest("hex");
        }
        await this.run(closeWithoutSaveScript(path, expectedSha256));
      }
      for (let i = 0; i < 40; i++) {
        if (!(await this.list()).some((e) => e.projectPath === path)) {
          return { closed: true, projectPath: path, saved: options.save !== false };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error("Screen Studio editor window did not finish closing.");
    });
  }

  async raw(projectPath: string) {
    const path = await this.studio.path(projectPath);
    const { serializedProject, ...state } = await this.run<any>(
      `const c = __ss.get(${j(path)}); const serializedProject = c.project.serialize(); const { scenes, config, ...metadata } = __ss.summary(c, serializedProject); return { ...metadata, serializedProject };`,
    );
    return {
      ...state,
      scenes: serializedProject.scenes.map((scene: any) => ({
        id: scene.id,
        name: scene.name,
        slices: scene.slices,
        zooms: scene.zooms,
        layouts: scene.layouts,
        masks: scene.masks,
        voiceOvers: scene.voiceOvers,
      })),
      config: serializedProject.config,
      editFingerprint: projectEditFingerprint(serializedProject),
    };
  }

  private async captureSnapshot(path: string) {
    const appVersion = await this.studio.requireVersion("read");
    const captured = await this.run<{
      project: Record<string, unknown>;
      editGeneration: number;
      editRunning: boolean;
      unsavedChanges: boolean;
      sourceDurationMs: number;
      writeQuarantine: { saveId: string; since: number; instanceId?: string; phase: string } | null;
      rendererInstanceId: string;
    }>(`
      const c = __ss.get(${j(path)});
      const projectJSONValue = ${projectJSONValue.toString()};
      const project = projectJSONValue(c.project.serialize());
      return { project, editGeneration: c.project.editGeneration,
        editRunning: !!__ss.busy()[${j(path)}], unsavedChanges: c.project.isDirty,
        writeQuarantine: __ss.pendingWrite(${j(path)}),
        rendererInstanceId: __ss.instanceId,
        sourceDurationMs: c.project.sourceDurationMs };
    `);
    if (
      !captured ||
      typeof appVersion !== "string" ||
      !appVersion ||
      !Number.isInteger(captured.editGeneration) ||
      captured.editGeneration < 0 ||
      typeof captured.unsavedChanges !== "boolean" ||
      typeof captured.editRunning !== "boolean" ||
      !captured.project ||
      !Array.isArray(captured.project.scenes) ||
      !captured.project.config ||
      typeof captured.project.config !== "object" ||
      Array.isArray(captured.project.config) ||
      typeof captured.project.version !== "string" ||
      !captured.project.version
    ) {
      throw new Error("Native snapshot shape is unsupported; no revision fence was issued.");
    }
    return { ...captured, appVersion };
  }

  async snapshot(projectPath: string) {
    const path = await this.studio.path(projectPath);
    const captured = await this.captureSnapshot(path);
    const { appVersion } = captured;
    const projection = publicSnapshot(captured.project);
    const revisionBasis = appVersion === APP_BUILD ? "native-edit" : "serialized-content";
    const fingerprint = await (
      revisionBasis === "native-edit" ? keyedEditRevisionFingerprint : keyedRevisionFingerprint
    )(captured.project, await this.studio.statePath("revision-integrity.key"));
    const legacyExportFence = projection.redactedPaths.length
      ? { status: "unavailable" as const, reason: "redacted-private-settings" }
      : { status: "available" as const, editFingerprint: projectEditFingerprint(captured.project) };
    return {
      snapshotVersion: 1,
      appVersion,
      schema: captured.project.version,
      projectPath: path,
      editGeneration: captured.editGeneration,
      editRunning: captured.editRunning,
      writeQuarantine: captured.writeQuarantine,
      rendererInstanceId: captured.rendererInstanceId,
      unsavedChanges: captured.unsavedChanges,
      revisionFingerprint: fingerprint,
      revisionBasis,
      legacyExportFence,
      ...projection,
    };
  }

  async state(projectPath: string) {
    return this.describeState(await this.raw(projectPath));
  }

  async stateWithConfig(projectPath: string) {
    const captured = await this.raw(projectPath);
    return { ...this.describeState(captured), config: captured.config };
  }

  private describeState(s: Awaited<ReturnType<Editor["raw"]>>) {
    return {
      projectPath: s.projectPath,
      name: s.name,
      unsavedChanges: s.dirty,
      editGeneration: s.editGeneration,
      editFingerprint: s.editFingerprint,
      playheadMs: round(s.playheadMs),
      playing: s.playing,
      playbackDurationMs: round(s.playbackDurationMs),
      sourceDurationMs: round(s.sourceDurationMs),
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      editRunning: s.editRunning,
      writeQuarantine: s.writeQuarantine,
      scenes: s.scenes.map((sc: any) => ({
        id: sc.id,
        name: sc.name,
        ...describeScene(sc),
        voiceOvers: sc.voiceOvers.length,
      })),
      style: {
        screenSpring: s.config.animations.screenMovementSpring,
        cursorSpring: s.config.animations.mouseMovementSpring,
        motionBlur: s.config.animations.motionBlurAmount,
        zoomsStartEarly: s.config.zooms.startAnimationEarly,
        cursor: {
          size: s.config.cursor.size,
          hide: s.config.cursor.hide,
          hideWhenStillMs: s.config.cursor.hideNotMovingAfterMs,
          clickEffect: s.config.cursor.clickEffect,
          stopMovementInLastPartMs: s.config.cursor.stopMovementInLastPartMs,
        },
        output: s.config.output,
        background: {
          type: s.config.styles.background.type,
          color: s.config.styles.background.color,
          systemName: s.config.styles.background.systemName,
        },
        padding: s.config.output.paddingRatio01,
        borderRadius: s.config.styles.screenBorderRadius,
      },
    };
  }

  /**
   * The editor's live project data, or null when the app is closed or the project is not
   * open. A failed lookup in a running app throws, so callers never fall back to a stale save.
   */
  async liveProject(projectPath: string): Promise<any | null> {
    if (!(await this.studio.isRunning())) return null;
    return this.run(
      `const c = __ss.contexts().find((c) => c.project.path === ${j(projectPath)});
       if (c) __ss.observe(c.project.path);
       return c ? c.project.serialize() : null;`,
    );
  }

  async requireEditable(projectPath: string) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    await this.run(`__ss.edit(${j(path)}); return true;`);
  }

  async saveObservation(projectPath: string, saveId: string, expectedInstanceId?: string) {
    saveId = saveId.toLowerCase();
    assertUuid(saveId, "Invalid save ID.");
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion("read");
    return this.run(`
      const saved = window.__ssmcpPendingWrites?.[${j(saveId.toLowerCase())}];
      const instanceId = window.__ssmcpRendererInstance ?? null;
      const replacement = ${j(expectedInstanceId) ?? "undefined"} === undefined ? {} : { rendererReplaced: instanceId !== ${j(expectedInstanceId) ?? "undefined"} };
      if (!saved) return { found: false, reason: 'observationAbsent', instanceId, ...replacement };
      if (saved.projectPath !== ${j(path)}) throw new Error('Save ID belongs to another project.');
      return { found: true, instanceId, ...replacement, observation: {
        saveId: saved.saveId, projectPath: saved.projectPath, instanceId: saved.instanceId,
        phase: saved.phase, startedAtMs: saved.startedAtMs, settledAtMs: saved.settledAtMs,
        cleanMarked: saved.cleanMarked, diverged: saved.diverged, dispatchThrew: saved.dispatchThrew,
        saveReason: saved.saveReason
      } };
    `);
  }

  private async mutationReceiptNow(path: string, mutationId: string): Promise<MutationReceipt | null> {
    const file = await this.studio.statePath(`mutation-${mutationId}.json`);
    let receipt = await readMutationReceipt(file);
    let fromDisk = !!receipt;
    if (!receipt) {
      const raw = await this.studio
        .requireVersion("read")
        .then(() =>
          this.run<RendererReceipt | null>(
            `return window.__ssmcpRevisionReceipts?.[${j(mutationId)}] ?? null;`,
          ),
        )
        .catch(() => {
          throw new RendererReceiptUnavailable(
            "The renderer could not be queried; retry receipt lookup without dispatching another edit.",
          );
        });
      if (!raw) return null;
      if (raw.persisted) {
        if (raw.projectPath !== path || raw.mutationId !== mutationId)
          throw new Error("Mutation ID belongs to another project; no edit was retried.");
        receipt = await readMutationReceipt(file);
        if (!receipt)
          throw new Error(
            "The renderer acknowledged this mutation, but its durable receipt is missing from this SDK state directory. Use its originating state or reconcile the missing evidence.",
          );
        fromDisk = true;
      } else {
        const keyPath = await this.studio.statePath("revision-integrity.key");
        const beforeFingerprint = raw.before
          ? await keyedEditRevisionFingerprint(raw.before, keyPath)
          : undefined;
        receipt = {
          receiptVersion: 1,
          mutationId: raw.mutationId,
          projectPath: raw.projectPath,
          requestFingerprint: raw.requestFingerprint,
          phase: raw.phase,
          ...(raw.status ? { status: raw.status } : {}),
          ...(raw.reason ? { reason: raw.reason } : {}),
          ...(beforeFingerprint ? { beforeFingerprint } : {}),
          ...(raw.beforeGeneration !== undefined ? { beforeGeneration: raw.beforeGeneration } : {}),
          ...(raw.after ? { afterFingerprint: await keyedEditRevisionFingerprint(raw.after, keyPath) } : {}),
          ...(raw.afterGeneration !== undefined ? { afterGeneration: raw.afterGeneration } : {}),
          ...(raw.results ? { results: raw.results } : {}),
          ...(raw.failedAt !== undefined ? { failedAt: raw.failedAt } : {}),
          ...(raw.saved !== undefined ? { saved: raw.saved } : {}),
          ...(raw.saveFailed ? { saveFailed: true } : {}),
          ...(raw.saveOutcome ? { saveOutcome: raw.saveOutcome } : {}),
          ...(raw.saveReason ? { saveReason: raw.saveReason } : {}),
          ...(raw.saveId ? { saveId: raw.saveId } : {}),
          ...(raw.instanceId ? { instanceId: raw.instanceId } : {}),
          ...(raw.startedAtMs !== undefined ? { startedAtMs: raw.startedAtMs } : {}),
          ...(raw.errorCode ? { errorCode: raw.errorCode } : {}),
        };
      }
    }
    if (receipt.projectPath !== path || receipt.mutationId !== mutationId)
      throw new Error("Mutation ID belongs to another project; no edit was retried.");
    const authority = await keyedRevisionFingerprint(
      { purpose: "revision-authority" },
      await this.studio.statePath("revision-integrity.key"),
    );
    const requestAuthority = JSON.parse(receipt.requestFingerprint).keyId;
    if (
      requestAuthority !== authority.keyId ||
      (receipt.beforeFingerprint && receipt.beforeFingerprint.keyId !== authority.keyId)
    )
      throw new Error("Mutation receipt uses a different integrity authority; reconcile before continuing.");
    if (!fromDisk) {
      await persistMutationReceipt(file, receipt);
      await this.compactReceipt(receipt);
    }
    return receipt;
  }

  private async compactReceipt(receipt: MutationReceipt) {
    const mutationId = receipt.mutationId;
    if (receipt.phase === "complete")
      await this.run(
        `
        const r = window.__ssmcpRevisionReceipts?.[${j(mutationId)}];
        if (r && r.phase === 'complete' && r.requestFingerprint === ${j(receipt.requestFingerprint)}) {
          window.__ssmcpRevisionReceipts[${j(mutationId)}] = {
            receiptVersion: 1, mutationId: r.mutationId, projectPath: r.projectPath,
            requestFingerprint: r.requestFingerprint, phase: 'complete', persisted: true
          };
        }
        return true;
      `,
      ).catch(() => {});
  }

  async recoverMutationReceipts() {
    if (!(await this.studio.isRunning())) return { recovered: 0 };
    const candidates = await this.run<
      Array<{ mutationId: string; projectPath: string; requestFingerprint: string }>
    >(`
      return Object.values(window.__ssmcpRevisionReceipts ?? {})
        .filter(r => r.phase === 'complete' && !r.persisted)
        .map(r => ({ mutationId: r.mutationId, projectPath: r.projectPath, requestFingerprint: r.requestFingerprint }));
    `);
    let recovered = 0;
    for (const candidate of candidates) {
      const intent = await readMutationIntent(
        await this.studio.statePath(`mutation-${candidate.mutationId}.intent.json`),
      );
      if (!intent || intent.requestFingerprint !== candidate.requestFingerprint) continue;
      await this.assertMutationIntent(candidate.projectPath, candidate.mutationId, intent);
      const receipt = await this.mutationReceiptNow(candidate.projectPath, candidate.mutationId);
      if (receipt?.phase === "complete") {
        await this.compactReceipt(receipt);
        recovered++;
      }
    }
    return { recovered };
  }

  private async assertMutationIntent(path: string, mutationId: string, intent: MutationIntent) {
    if (intent.projectPath !== path || intent.mutationId !== mutationId)
      throw new Error("Mutation ID belongs to another project; no edit was retried.");
    const authority = await keyedRevisionFingerprint(
      { purpose: "revision-authority" },
      await this.studio.statePath("revision-integrity.key"),
    );
    if (JSON.parse(intent.requestFingerprint).keyId !== authority.keyId)
      throw new Error("Mutation intent uses a different integrity authority; reconcile before continuing.");
  }

  async mutationReceipt(projectPath: string, mutationId: string) {
    mutationId = mutationId.toLowerCase();
    assertUuid(mutationId, "Invalid mutation ID.");
    const path = await this.studio.path(projectPath);
    const intent = await readMutationIntent(
      await this.studio.statePath(`mutation-${mutationId}.intent.json`),
    );
    if (intent) await this.assertMutationIntent(path, mutationId, intent);
    let receipt;
    try {
      receipt = await this.mutationReceiptNow(path, mutationId);
    } catch (error) {
      if (!(error instanceof RendererReceiptUnavailable)) throw error;
      return intent
        ? { found: true as const, receipt: unresolvedMutation(intent, "rendererUnavailable") }
        : { found: false as const, reason: "rendererUnavailable" as const, retryable: true };
    }
    if (receipt) return { found: true as const, receipt };
    return intent
      ? { found: true as const, receipt: unresolvedMutation(intent) }
      : { found: false as const, reason: "receiptAbsent" as const, retryable: false };
  }

  async applyRevision(
    projectPath: string,
    sceneId: string | undefined,
    ops: EditOp[],
    options: { mutationId: string; expectedFingerprint: KeyedRevisionFingerprint; save: boolean },
  ) {
    options = { ...options, mutationId: options.mutationId.toLowerCase() };
    if (!ops.length && !options.save) throw new Error("An empty revision batch requires save:true.");
    assertUuid(options.mutationId, "Invalid mutation ID.");
    const path = await this.studio.path(projectPath);
    return this.locked(path, async () => {
      const keyPath = await this.studio.statePath("revision-integrity.key");
      const requestFingerprint = j(
        await keyedRevisionFingerprint(
          {
            purpose: "native-mutation-request",
            projectPath: path,
            sceneId: sceneId ?? null,
            ops,
            expectedFingerprint: options.expectedFingerprint,
            save: options.save,
          },
          keyPath,
        ),
      );
      const intentPath = await this.studio.statePath(`mutation-${options.mutationId}.intent.json`);
      const intent = await readMutationIntent(intentPath);
      if (intent) {
        await this.assertMutationIntent(path, options.mutationId, intent);
        if (intent.requestFingerprint !== requestFingerprint)
          throw new Error("Mutation ID already belongs to a different request; nothing was retried.");
      }
      let previous;
      try {
        previous = await this.mutationReceiptNow(path, options.mutationId);
      } catch (error) {
        if (!(error instanceof RendererReceiptUnavailable) || !intent) throw error;
        return unresolvedMutation(intent, "rendererUnavailable");
      }
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint)
          throw new Error("Mutation ID already belongs to a different request; nothing was retried.");
        return previous;
      }
      if (intent) return unresolvedMutation(intent);
      if ((await this.studio.requireVersion("write")) !== APP_BUILD)
        throw new Error(
          "Native revision mutations require the tested Screen Studio build; no intent was reserved.",
        );
      const before = await this.captureSnapshot(path);
      if (before.writeQuarantine)
        throw new Error(
          "This project has an unresolved native save; no new mutation intent was reserved. Inspect its save observation before editing.",
        );
      const fingerprint = await keyedEditRevisionFingerprint(before.project, keyPath);
      const matches = sameRevisionFingerprint(fingerprint, options.expectedFingerprint);
      const scenes = before.project.scenes as Array<{
        id: string;
        slices: Array<{ sourceEndMs: number }>;
        zooms: Array<{ id: string; sourceStartMs: number; sourceEndMs: number }>;
        layouts: Array<{ id: string; sourceStartMs: number; sourceEndMs: number }>;
        masks: Array<{ id: string; sourceStartMs: number; sourceEndMs: number }>;
      }>;
      const scene = sceneId ? scenes.find((scene) => scene.id === sceneId) : scenes[0];
      let prepared: ReturnType<typeof prepareOps> = [];
      if (matches && !before.editRunning) {
        if (!scene) throw new Error("Scene does not exist; no mutation was submitted.");
        prepared = prepareOps(ops, {
          sourceMs: Math.max(before.sourceDurationMs, ...scene.slices.map((slice) => slice.sourceEndMs)),
          config: before.project.config,
          captureSize: await captureSize(path),
          tracks: { zooms: scene.zooms, layouts: scene.layouts, masks: scene.masks },
        });
      }
      const reservation: MutationIntent = {
        intentVersion: 1,
        mutationId: options.mutationId,
        projectPath: path,
        requestFingerprint,
        expectedFingerprint: options.expectedFingerprint,
      };
      if (!(await reserveMutationIntent(intentPath, reservation))) {
        return (await this.mutationReceiptNow(path, options.mutationId)) ?? unresolvedMutation(reservation);
      }
      if (before.editRunning) {
        const refused: MutationReceipt = {
          receiptVersion: 1,
          mutationId: options.mutationId,
          projectPath: path,
          requestFingerprint,
          phase: "complete",
          status: "notApplied",
          reason: "editorBusy",
          beforeFingerprint: fingerprint,
          beforeGeneration: before.editGeneration,
        };
        await persistMutationReceipt(
          await this.studio.statePath(`mutation-${options.mutationId}.json`),
          refused,
        );
        return refused;
      }
      try {
        await this.run(
          transactionScript(path, scene?.id ?? "", prepared, {
            mutationId: options.mutationId,
            requestFingerprint,
            expectedSha256: matches ? revisionFingerprint(editProjectValue(before.project)).sha256 : "",
            save: options.save,
          }),
          120000,
        );
      } catch (error) {
        if (!(error instanceof CommandNotSentError)) throw error;
        const refused: MutationReceipt = {
          receiptVersion: 1,
          mutationId: options.mutationId,
          projectPath: path,
          requestFingerprint,
          phase: "complete",
          status: "notApplied",
          reason: "notDispatched",
        };
        await persistMutationReceipt(
          await this.studio.statePath(`mutation-${options.mutationId}.json`),
          refused,
        );
        return refused;
      }
      const receipt = await this.mutationReceiptNow(path, options.mutationId);
      if (!receipt)
        throw new Error("Mutation outcome is unknown; look up the same mutation ID before continuing.");
      return receipt;
    });
  }

  /**
   * Applies ops after saving a checkpoint. When an op fails partway, the ops
   * before it stay applied and the result says so (partial, failedAt, error)
   * with the checkpointId that undoes the whole batch.
   */
  async apply(
    projectPath: string,
    sceneId: string | undefined,
    ops: EditOp[],
    show?: { stepMs: number },
    options: { save?: boolean; signal?: AbortSignal; expectedGeneration?: number } = {},
  ) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, async () => {
      await this.requireEditable(path);
      const before = await this.raw(path);
      if (options.expectedGeneration !== undefined && options.expectedGeneration !== before.editGeneration)
        throw new Error(
          "The project changed since it was inspected. Read the current editor state before editing.",
        );
      const scene = sceneId ? before.scenes.find((s: any) => s.id === sceneId) : before.scenes[0];
      if (!scene) throw new Error("Scene does not exist.");
      const source = Math.max(...scene.slices.map((s: any) => s.sourceEndMs), before.sourceDurationMs);
      // Validate everything before touching the editor.
      const prepared = prepareOps(ops, {
        sourceMs: source,
        config: before.config,
        captureSize: await captureSize(path),
        tracks: { zooms: scene.zooms, layouts: scene.layouts, masks: scene.masks },
      });
      const checkpointId = randomUUID();
      await writeFile(
        await this.studio.statePath(`editor-${checkpointId}.json`),
        j({
          projectPath: path,
          sceneId: scene.id,
          slices: scene.slices,
          zooms: scene.zooms,
          layouts: scene.layouts,
          masks: scene.masks,
          voiceOvers: scene.voiceOvers,
          config: before.config,
        }),
        { mode: 0o600, flag: "wx" },
      );
      let run: { results: any[]; failedAt?: number; error?: string };
      // Cancelling stops the batch between ops; the checkpoint still undoes what ran.
      const cancel = () => {
        this.run(
          `const b = __ss.busy()[${j(path)}]; if (b?.kind === 'edit' && b.checkpointId === ${j(checkpointId)}) b.cancel = true; return true;`,
        ).catch(() => {});
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        run = await this.run(
          applyScript(path, scene.id, prepared, show, before.editGeneration, false, checkpointId),
          show ? 600000 : 30000,
        );
      } catch (e) {
        const err = new Error(
          `${e instanceof Error ? e.message : String(e)} Some ops may have been applied; screenstudio_editor_restore with checkpointId ${checkpointId} puts the editor back.`,
        );
        Object.assign(err, { checkpointId });
        throw err;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
      if (run.failedAt === undefined) {
        // Saved inside the same lock, so no other call's edit lands between apply and save.
        const saved = options.save ? await this.saveNow(path) : undefined;
        return { results: run.results, checkpointId, ...saved };
      }
      return {
        partial: true,
        failedAt: run.failedAt,
        error: `Op ${run.failedAt} (${ops[run.failedAt]?.op}) failed: ${run.error} The ops before it are applied; screenstudio_editor_restore with checkpointId ${checkpointId} undoes the whole batch.`,
        results: run.results,
        checkpointId,
      };
    });
  }

  async restore(checkpointId: string) {
    assertUuid(checkpointId, "Invalid checkpoint.");
    await this.studio.requireVersion();
    const saved = JSON.parse(
      await readFile(join(this.studio.stateDir, `editor-${checkpointId}.json`), "utf8"),
    );
    return this.locked(saved.projectPath, async () => {
      await this.run(`
        const c = __ss.edit(${j(saved.projectPath)});
        const sc = __ss.scene(c, ${j(saved.sceneId)});
        const voiceOvers = ${j(saved.voiceOvers ?? null)};
        if (voiceOvers && typeof sc.voiceOvers.replace !== 'function') {
          const now = c.project.serialize().scenes.find((s) => s.id === sc.id).voiceOvers;
          if (JSON.stringify(now) !== JSON.stringify(voiceOvers)) throw new Error('This Screen Studio build cannot put voiceovers back; nothing was restored.');
        }
        sc.slices.replace(${j(saved.slices)});
        sc.zooms.replace(${j(saved.zooms)});
        if (${j(!!saved.layouts)}) sc.layouts.replace(${j(saved.layouts ?? [])});
        if (${j(!!saved.masks)}) sc.masks.replace(${j(saved.masks ?? [])});
        if (voiceOvers && typeof sc.voiceOvers.replace === 'function') sc.voiceOvers.replace(voiceOvers);
        const cfg = ${j(saved.config)};
        c.project.projectConfig.update({ crop: cfg.crop, cursor: cfg.cursor, animations: cfg.animations, zooms: cfg.zooms, output: cfg.output, styles: cfg.styles, captions: cfg.captions, audio: cfg.audio, camera: cfg.camera, processing: cfg.processing, defaultLayout: cfg.defaultLayout, device: cfg.device });
        return true;
      `);
      return saved.projectPath as string;
    });
  }

  async history(projectPath: string, action: "undo" | "redo", steps: number) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, () =>
      this.run(`
      const h = __ss.edit(${j(path)}).project.history;
      let done = 0;
      for (let i = 0; i < ${Number(steps)}; i++) {
        if (!(${action === "undo" ? "h.canUndo" : "h.canRedo"})) break;
        h.${action}(); done++;
      }
      return { done, canUndo: h.canUndo, canRedo: h.canRedo };
    `),
    );
  }

  async save(projectPath: string) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, async () => {
      await this.requireEditable(path);
      return this.saveNow(path);
    });
  }

  /** Same steps as the editor's own save: serialize, write through the app, mark saved. Caller holds the lock. */
  private async saveNow(path: string, saveId = randomUUID()): Promise<SaveOutcome> {
    try {
      return await this.run<SaveOutcome>(
        `
      let c;
      try { c = __ss.edit(${j(path)}); }
      catch { return { saved: false, saveOutcome: 'notSent', saveReason: 'rendererRefused', writeQuarantine: __ss.pendingWrite(${j(path)}) }; }
      const p = c.project;
      const generation = p.editGeneration;
      const data = structuredClone(p.serialize());
      const barrier = { since: Date.now(), kind: 'edit' };
      __ss.busy()[${j(path)}] = barrier;
      try { return await __ssSave(c, data, generation, barrier, ${j(saveId)}); }
      catch { return { saved: false, saveOutcome: barrier.kind === 'pendingWrite' ? 'unknown' : 'notSent', saveReason: 'saveHelperFailed',
        ...(barrier.kind === 'pendingWrite' ? { saveId: ${j(saveId)}, instanceId: window.__ssmcpRendererInstance,
          startedAtMs: window.__ssmcpPendingWrites?.[${j(saveId)}]?.startedAtMs } : {}) }; }
      finally {
        if (__ss.busy()[${j(path)}] === barrier && barrier.kind !== 'pendingWrite')
          delete __ss.busy()[${j(path)}];
      }
    `,
        60000,
      );
    } catch (error) {
      return {
        saved: false,
        saveOutcome: error instanceof CommandNotSentError ? "notSent" : "unknown",
        saveReason: "saveCallFailed",
        saveId,
      };
    }
  }

  async seek(projectPath: string, at: { playbackMs?: number; sourceMs?: number }) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`
      const pb = __ss.edit(${j(path)}).playback;
      pb.pause();
      ${at.sourceMs !== undefined ? `pb.goToSourceTime(${Number(at.sourceMs)});` : `pb.goTo(${Number(at.playbackMs ?? 0)});`}
      return { playheadMs: Math.round(pb.playbackTimeMs) };
    `),
    );
  }

  async play(projectPath: string, fromMs: number, toMs?: number) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`
      const pb = __ss.edit(${j(path)}).playback;
      clearInterval(window.__ssmcpStop);
      pb.playAt(${Number(fromMs)});
      ${toMs !== undefined ? `window.__ssmcpStop = setInterval(() => { if (!pb.isPlaying || pb.playbackTimeMs >= ${Number(toMs)}) { clearInterval(window.__ssmcpStop); pb.pause(); } }, 30);` : ""}
      return { playing: true, fromMs: ${Number(fromMs)}, toMs: ${toMs ?? "null"} };
    `),
    );
  }

  /** Captures the editor's preview canvas at a playback time, as rendered by the app. */
  async frame(projectPath: string, playbackMs: number) {
    return (await this.frames(projectPath, [playbackMs]))[0];
  }

  /** Captures several playback times in one go: the window is looked up once for all of them. */
  async frames(projectPath: string, playbackMs: number[]) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, async () => {
      const window = await this.frameWindow(path);
      const out = [];
      for (const t of playbackMs) out.push(await this.captureAt(path, window, t));
      return out;
    });
  }

  /** The editor window's id and where its preview canvas sits, in window points. */
  private async frameWindow(path: string) {
    const tag = `ssmcp-${randomUUID().slice(0, 8)}`;
    const info = await this.run<any>(`
      const c = __ss.observe(${j(path)});
      const w = c.view.targetWindow;
      // The preview draws at the display's pixel ratio; panel backdrops are canvases
      // too, drawn at 1x, and can be larger than the preview in a small window.
      const all = [...w.document.querySelectorAll('canvas')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const sharp = all.filter((x) => x.el.width >= x.r.width * Math.min(1.5, w.devicePixelRatio || 1) - 1);
      const canvas = (w.devicePixelRatio > 1 && sharp.length ? sharp : all)[0];
      if (!canvas) throw new Error('The editor preview is not visible.');
      const title = w.document.title;
      w.document.title = ${j(tag)};
      return { title, x: canvas.r.x, y: canvas.r.y, width: canvas.r.width, height: canvas.r.height, outerWidth: w.outerWidth, outerHeight: w.outerHeight, innerHeight: w.innerHeight, name: c.project.name };
    `);
    let windowId: number;
    try {
      await new Promise((r) => setTimeout(r, 150));
      windowId = await this.desktop.findWindowByTitle(tag);
    } finally {
      await this.run(
        `__ss.get(${j(path)}).view.targetWindow.document.title = ${j(info.title ?? editorWindowTitle(info.name))}; return true;`,
      ).catch(() => {});
    }
    return { windowId, tag, canvas: info as Record<string, number> };
  }

  /** Moves the playhead, waits for the preview to draw, and crops the window shot to the canvas. */
  private async captureAt(
    path: string,
    window: Awaited<ReturnType<Editor["frameWindow"]>>,
    playbackMs: number,
  ) {
    const { playheadMs, editGeneration } = await this.run<{ playheadMs: number; editGeneration: number }>(
      previewSeekScript(path, playbackMs),
    );
    const { tag, canvas: info } = window;
    const full = await this.studio.statePath(`editor-window-${tag}.png`);
    const out = join(this.studio.stateDir, `editor-frame-${tag}-${round(playbackMs)}.png`);
    try {
      await captureWindow(window.windowId, full);
      await this.run(`
        const c = __ss.observe(${j(path)});
        if (Math.abs(c.playback.playbackTimeMs - ${playheadMs}) > 1 || c.project.editGeneration !== ${editGeneration})
          throw new Error('The playhead or project changed during capture. Inspect the current editor before requesting another frame.');
        return true;
      `);
      const png = await readFile(full);
      // PNG width sits at byte 16 of the header; it gives the screen's backing scale.
      const scale = png.readUInt32BE(16) / info.outerWidth;
      const top = info.outerHeight - info.innerHeight;
      const px = (v: number) => Math.round(v * scale);
      await cropPng(full, out, {
        x: px(info.x),
        y: px(info.y + top),
        width: px(info.width),
        height: px(info.height),
      });
    } finally {
      // The whole-window shot is only a step on the way to the cropped frame.
      await rm(full, { force: true }).catch(() => {});
    }
    return { path: resolve(out), playheadMs, data: await readFile(out) };
  }

  /** Editor interface: open a panel, select an item, zoom the timeline, show or hide parts. */
  async view(
    projectPath: string,
    v: {
      panel?: string;
      select?: { track: string; id: string };
      timelineMs?: number;
      sidebar?: boolean;
      timeline?: boolean;
      previewOnly?: boolean;
      close?: boolean;
      cropWindow?: boolean;
      lutStudio?: boolean;
      shortcutsGuide?: boolean;
    },
  ) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, async () => {
      await this.studio.requireVersion();
      return this.run(`
      const c = __ss.edit(${j(path)}); const view = c.view; const v = ${j(v)};
      if (v.panel) view.setSidebarRoot(v.panel);
      if (v.select) { const kind = { zooms: ['zoom', 'zoomId'], masks: ['mask', 'maskId'], layouts: ['layout', 'layoutId'], slices: ['slice', 'sliceId'] }[v.select.track]; if (!kind) throw new Error('Unknown track ' + v.select.track); view.setSidebarItem({ type: kind[0], [kind[1]]: v.select.id }); }
      if (v.close) view.closeSidebarItem?.();
      if (v.timelineMs) view.setVisiblePlaybackDurationMs(v.timelineMs);
      if (v.sidebar !== undefined && view.shouldShowSidebar !== v.sidebar) view.toggleSidebar();
      if (v.timeline !== undefined && view.shouldShowTimeline !== v.timeline) view.toggleTimeline();
      if (v.previewOnly !== undefined) { const only = !view.shouldShowSidebar && !view.shouldShowTimeline; if (only !== v.previewOnly) view.togglePreview(); }
      if (v.cropWindow !== undefined) view.isCropWindowOpen = v.cropWindow;
      if (v.lutStudio !== undefined) view.isLutStudioWindowOpen = v.lutStudio;
      if (v.shortcutsGuide !== undefined) view.isShortcutsGuideVisible = v.shortcutsGuide;
      await new Promise((r) => setTimeout(r, 600));
      return {
        panel: view.sidebarRoot,
        item: view.sidebarItem,
        timelineMs: Math.round(view.pendingVisiblePlaybackDurationMs ?? view.visiblePlaybackDurationMs),
        sidebar: view.shouldShowSidebar,
        timeline: view.shouldShowTimeline,
        cropWindow: !!view.isCropWindowOpen,
        lutStudio: !!view.isLutStudioWindowOpen,
        shortcutsGuide: !!view.isShortcutsGuideVisible,
      };
    `);
    });
  }

  /** Updates top-level projectConfig groups live inside the open editor (respecting lock & undo). */
  async updateConfig(projectPath: string, partial: Record<string, unknown>) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, async () => {
      await this.studio.requireVersion();
      return this.run(`__ss.edit(${j(path)}).project.projectConfig.update(${j(partial)}); return true;`);
    });
  }

  /** Sets the project's audio track settings in the editor (used by narration). */
  async setAudio(projectPath: string, audio: Record<string, unknown>) {
    return this.updateConfig(projectPath, { audio });
  }
}
