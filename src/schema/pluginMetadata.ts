import fs from "node:fs/promises";
import path from "node:path";
import { evaluateUrlSecurity } from "./security";
import type {
  CompletionPrimitive,
  ManifestSecurityPolicy,
  PluginHintDocumentV1,
  PluginHintEntry,
  PluginHintProperty,
} from "./types";

const FETCH_TIMEOUT_MS = 8_000;

export type PluginHintLoadOptions = {
  workspaceRoot?: string;
  localPath?: string;
  remoteUrl?: string;
  securityPolicy: ManifestSecurityPolicy;
  fetchFn?: typeof fetch;
};

export type PluginHintLoadResult = {
  entries: PluginHintEntry[];
  warnings: string[];
};

export function isPluginHintDocumentV1(value: unknown): value is PluginHintDocumentV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PluginHintDocumentV1>;
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
    return false;
  }
  return candidate.entries.every(isPluginHintEntry);
}

export async function loadPluginHintEntries(
  options: PluginHintLoadOptions,
): Promise<PluginHintLoadResult> {
  const warnings: string[] = [];
  const layers: PluginHintEntry[][] = [];

  if (options.remoteUrl?.trim()) {
    const remote = await loadRemoteEntries(options).catch((error) => {
      warnings.push(`Remote plugin metadata failed: ${toErrorMessage(error)}`);
      return [];
    });
    layers.push(remote);
  }

  if (options.workspaceRoot && options.localPath?.trim()) {
    const local = await loadLocalEntries(options).catch((error) => {
      warnings.push(`Local plugin metadata failed: ${toErrorMessage(error)}`);
      return [];
    });
    layers.push(local);
  }

  return {
    entries: mergePluginHintLayers(layers),
    warnings,
  };
}

function isPluginHintEntry(value: unknown): value is PluginHintEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PluginHintEntry>;
  if (typeof candidate.path !== "string" || !candidate.path.trim()) {
    return false;
  }
  if (!candidate.properties || typeof candidate.properties !== "object") {
    return false;
  }
  return Object.entries(candidate.properties).every(([key, property]) => {
    if (!key.trim()) {
      return false;
    }
    if (!property || typeof property !== "object") {
      return false;
    }
    const typed = property as PluginHintProperty;
    if (typed.description !== undefined && typeof typed.description !== "string") {
      return false;
    }
    if (typed.snippet !== undefined && typeof typed.snippet !== "string") {
      return false;
    }
    if (typed.type !== undefined && typeof typed.type !== "string") {
      return false;
    }
    if (typed.defaultValue !== undefined && !isCompletionPrimitive(typed.defaultValue)) {
      return false;
    }
    if (!isCompletionPrimitiveArray(typed.enumValues)) {
      return false;
    }
    if (!isCompletionPrimitiveArray(typed.examples)) {
      return false;
    }
    return true;
  });
}

async function loadLocalEntries(options: PluginHintLoadOptions): Promise<PluginHintEntry[]> {
  const workspaceRoot = options.workspaceRoot;
  const localPath = options.localPath;
  if (!workspaceRoot || !localPath) {
    return [];
  }

  if (path.isAbsolute(localPath)) {
    throw new Error(
      "Plugin metadata local path must be workspace-relative (absolute paths are not allowed).",
    );
  }

  const resolvedPath = path.resolve(workspaceRoot, localPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) {
    throw new Error("Plugin metadata local path must not escape the workspace root.");
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return parsePluginHintEntries(raw, "local");
}

async function loadRemoteEntries(options: PluginHintLoadOptions): Promise<PluginHintEntry[]> {
  const remoteUrl = options.remoteUrl?.trim();
  if (!remoteUrl) {
    return [];
  }
  const evaluation = evaluateUrlSecurity(remoteUrl, options.securityPolicy);
  if (!evaluation.allowed) {
    throw new Error(`Blocked by security policy: ${evaluation.reason}`);
  }

  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(remoteUrl, {
      signal: controller.signal,
      headers: {
        "cache-control": "no-cache",
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch failed (${response.status}) for ${remoteUrl}`);
    }
    const raw = await response.text();
    return parsePluginHintEntries(raw, "remote");
  } finally {
    clearTimeout(timer);
  }
}

function parsePluginHintEntries(raw: string, source: "local" | "remote"): PluginHintEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${source} JSON: ${toErrorMessage(error)}`);
  }

  if (!isPluginHintDocumentV1(parsed)) {
    throw new Error(`Invalid ${source} plugin metadata shape (expected version=1).`);
  }

  return parsed.entries.map((entry) => ({
    path: normalizePattern(entry.path),
    properties: Object.fromEntries(
      Object.entries(entry.properties).map(([key, property]) => [
        key.trim(),
        {
          description: property.description?.trim() || undefined,
          snippet: property.snippet?.trim() || undefined,
          type: property.type?.trim() || undefined,
          enumValues: normalizePrimitiveArray(property.enumValues),
          examples: normalizePrimitiveArray(property.examples),
          defaultValue:
            property.defaultValue !== undefined
              ? normalizePrimitive(property.defaultValue)
              : undefined,
        },
      ]),
    ),
  }));
}

function mergePluginHintLayers(layers: PluginHintEntry[][]): PluginHintEntry[] {
  const merged = new Map<string, Map<string, PluginHintProperty>>();

  for (const layer of layers) {
    for (const entry of layer) {
      const key = normalizePattern(entry.path);
      const existing = merged.get(key) ?? new Map<string, PluginHintProperty>();
      for (const [propertyKey, property] of Object.entries(entry.properties)) {
        existing.set(propertyKey.trim(), property);
      }
      merged.set(key, existing);
    }
  }

  return [...merged.entries()].map(([pattern, properties]) => ({
    path: pattern,
    properties: Object.fromEntries(properties.entries()),
  }));
}

function normalizePattern(value: string): string {
  return value
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(".");
}

function normalizePrimitiveArray(values: CompletionPrimitive[] | undefined): CompletionPrimitive[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const normalized = values.map((value) => normalizePrimitive(value));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePrimitive(value: CompletionPrimitive): CompletionPrimitive {
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function isCompletionPrimitive(value: unknown): value is CompletionPrimitive {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function isCompletionPrimitiveArray(values: unknown): values is CompletionPrimitive[] | undefined {
  if (values === undefined) {
    return true;
  }
  if (!Array.isArray(values)) {
    return false;
  }
  return values.every((value) => isCompletionPrimitive(value));
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
