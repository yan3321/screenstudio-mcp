import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROJECT_VIEW_DATA_KEYS } from "../compat.js";

export interface PlainRevisionFingerprint {
  version: 2;
  algorithm: "sha256";
  sha256: string;
}

export interface KeyedRevisionFingerprint {
  version: 2 | 3;
  algorithm: "hmac-sha256";
  keyId: string;
  sha256: string;
}

export type RevisionFingerprint = PlainRevisionFingerprint | KeyedRevisionFingerprint;

export function projectJSONValue(project: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(project, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Native snapshot contains a non-finite number; exact JSON capture is unavailable.");
    }
    return value;
  });
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native snapshot must contain a project object.");
  }
  return value as Record<string, unknown>;
}

export function canonicalProjectJSON(project: Record<string, unknown>): string {
  const content = projectJSONValue(project);
  delete content.lastSavedAt;
  const encode = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const fields = value as Record<string, unknown>;
      return `{${Object.keys(fields)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(fields[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return encode(content);
}

export function revisionFingerprint(project: Record<string, unknown>): PlainRevisionFingerprint {
  return {
    version: 2,
    algorithm: "sha256",
    sha256: createHash("sha256").update(canonicalProjectJSON(project)).digest("hex"),
  };
}

async function revisionKey(path: string): Promise<Buffer> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!info) {
    const temporary = join(dirname(path), `.revision-key-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(randomBytes(32));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
  }
  const saved = await lstat(path);
  if (
    !saved.isFile() ||
    saved.isSymbolicLink() ||
    (process.platform !== "win32" && (saved.mode & 0o077) !== 0)
  ) {
    throw new Error("Revision integrity key must be a private regular file; existing state was preserved.");
  }
  const key = await readFile(path);
  if (key.length !== 32)
    throw new Error(
      "Revision integrity key is invalid; reconcile the existing revision state before replacing it.",
    );
  return key;
}

export async function keyedRevisionFingerprint(
  project: Record<string, unknown>,
  keyPath: string,
): Promise<KeyedRevisionFingerprint> {
  const key = await revisionKey(keyPath);
  return {
    version: 2,
    algorithm: "hmac-sha256",
    keyId: createHash("sha256").update(key).digest("hex").slice(0, 16),
    sha256: createHmac("sha256", key).update(canonicalProjectJSON(project)).digest("hex"),
  };
}

export function editProjectValue(project: Record<string, unknown>): Record<string, unknown> {
  const content = projectJSONValue(project);
  const data = content.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const key of PROJECT_VIEW_DATA_KEYS) delete (data as Record<string, unknown>)[key];
  }
  return content;
}

export async function keyedEditRevisionFingerprint(
  project: Record<string, unknown>,
  keyPath: string,
): Promise<KeyedRevisionFingerprint> {
  const fingerprint = await keyedRevisionFingerprint(editProjectValue(project), keyPath);
  return { ...fingerprint, version: 3 };
}

export function publicSnapshot(project: Record<string, unknown>): {
  project: Record<string, unknown>;
  redactedPaths: string[];
  redactedValueCount: number;
  projectExact: boolean;
} {
  const snapshot = projectJSONValue(project);
  const processing = (snapshot.config as { processing?: Record<string, unknown> } | undefined)?.processing;
  const redactedPaths: string[] = [];
  let redactedValueCount = 0;
  const privateValues = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string" && value.trim()) privateValues.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  if (processing && Object.hasOwn(processing, "sensitiveDataCustomPhrases")) {
    collect(processing.sensitiveDataCustomPhrases);
    delete processing.sensitiveDataCustomPhrases;
    redactedPaths.push("config.processing.sensitiveDataCustomPhrases");
  }
  const redact = (fields: Record<string, unknown> | unknown[], path: string) => {
    for (const [key, value] of Object.entries(fields)) {
      const child = path ? `${path}.${key}` : key;
      if (typeof value === "string" && privateValues.has(value)) {
        (fields as Record<string, unknown>)[key] = "[redacted]";
        redactedValueCount++;
      } else if (value && typeof value === "object") {
        redact(value as Record<string, unknown> | unknown[], child);
      }
    }
  };
  redact(snapshot, "");
  return { project: snapshot, redactedPaths, redactedValueCount, projectExact: redactedValueCount === 0 };
}
