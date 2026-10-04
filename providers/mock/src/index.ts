import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import {
  GenerationProviderError,
  type GenerationProvider,
  type GenerationProviderRequest,
  type ProviderArtifact,
  type ProviderCapabilities,
  type ProviderGenerationHandle,
  type ProviderGenerationSnapshot,
} from "@flowforge/core";

export type MockProviderMode =
  | "SUCCESS"
  | "TRANSIENT_FAILURE"
  | "PERMANENT_FAILURE"
  | "TIMEOUT"
  | "DUPLICATE_RESULT";

export type MockArtifactMode = "VALID_PNG" | "INVALID_PNG";

export interface MockGenerationProviderOptions {
  rootDir: string;
  mode?: MockProviderMode;
  failAttempts?: number;
  artifact?: MockArtifactMode;
}

interface MockManifest {
  providerRequestKey: string;
  providerJobId: string;
  attemptNumber: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  outputPath?: string;
  fileName?: string;
  mimeType?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const MOCK_CAPABILITIES: ProviderCapabilities = Object.freeze({
  imageGeneration: true,
  videoGeneration: false,
  referenceImages: true,
  startFrame: false,
  endFrame: false,
  batchGeneration: false,
});

/**
 * Deterministic file-backed test provider. Its request-key manifest and result file survive
 * worker/process restarts, so findGeneration() can recover a result before another submit.
 */
export class MockGenerationProvider implements GenerationProvider {
  readonly id = "mock";
  readonly capabilities = MOCK_CAPABILITIES;
  readonly rootDir: string;
  readonly mode: MockProviderMode;
  private readonly failAttempts: number;
  private readonly artifactMode: MockArtifactMode;

  constructor(options: MockGenerationProviderOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.mode = options.mode ?? "SUCCESS";
    this.failAttempts = options.failAttempts ?? (this.mode === "TRANSIENT_FAILURE" ? 1 : 0);
    this.artifactMode = options.artifact ?? "VALID_PNG";
    if (!Number.isSafeInteger(this.failAttempts) || this.failAttempts < 0) {
      throw new Error("MockProvider failAttempts must be a non-negative integer.");
    }
  }

  async findGeneration(providerRequestKey: string): Promise<ProviderGenerationHandle | null> {
    const manifest = await this.readManifest(providerRequestKey);
    return manifest ? { providerJobId: manifest.providerJobId, status: manifest.status } : null;
  }

  async createGeneration(request: GenerationProviderRequest): Promise<ProviderGenerationHandle> {
    const existing = await this.readManifest(request.providerRequestKey);
    if (existing) return { providerJobId: existing.providerJobId, status: existing.status };

    if (this.mode === "PERMANENT_FAILURE") {
      throw new GenerationProviderError({
        message: "MockProvider configured permanent failure.",
        code: "MOCK_PERMANENT_FAILURE",
        retryable: false,
        submissionUnknown: false,
      });
    }
    if (this.mode === "TRANSIENT_FAILURE" && request.attemptNumber <= this.failAttempts) {
      throw new GenerationProviderError({
        message: `MockProvider transient failure on attempt ${request.attemptNumber}.`,
        code: "MOCK_TRANSIENT_FAILURE",
        retryable: true,
        submissionUnknown: false,
      });
    }

    const providerJobId = `mock-${hashText(request.providerRequestKey)}`;
    const now = new Date().toISOString();
    let manifest: MockManifest;
    if (this.mode === "TIMEOUT") {
      manifest = {
        providerRequestKey: request.providerRequestKey,
        providerJobId,
        attemptNumber: request.attemptNumber,
        status: "RUNNING",
        createdAt: now,
        updatedAt: now,
      };
    } else {
      const bytes = this.artifactMode === "VALID_PNG" ? makeMockPng() : Buffer.from("invalid-png-test-artifact\n", "utf8");
      const outputPath = path.join(this.rootDir, "results", providerJobId, "output.png");
      await writeDeterministicFile(outputPath, bytes);
      manifest = {
        providerRequestKey: request.providerRequestKey,
        providerJobId,
        attemptNumber: request.attemptNumber,
        status: "SUCCEEDED",
        outputPath,
        fileName: "output.png",
        mimeType: "image/png",
        createdAt: now,
        updatedAt: now,
      };
    }
    await this.writeManifest(manifest);
    return { providerJobId, status: manifest.status };
  }

  async getGenerationStatus(providerJobId: string): Promise<ProviderGenerationSnapshot> {
    const manifest = await this.findManifestByProviderJobId(providerJobId);
    if (!manifest) {
      throw new GenerationProviderError({
        message: `MockProvider generation not found: ${providerJobId}`,
        code: "MOCK_GENERATION_NOT_FOUND",
        retryable: false,
        submissionUnknown: true,
      });
    }
    return {
      providerJobId,
      status: manifest.status,
      error: manifest.error,
      retryable: manifest.status === "FAILED" && this.mode === "TRANSIENT_FAILURE",
      errorCode: manifest.status === "FAILED" ? "MOCK_GENERATION_FAILED" : undefined,
    };
  }

  async downloadResult(providerJobId: string): Promise<ProviderArtifact[]> {
    const manifest = await this.findManifestByProviderJobId(providerJobId);
    if (!manifest) throw new Error(`MockProvider result not found: ${providerJobId}`);
    if (manifest.status !== "SUCCEEDED" || !manifest.outputPath || !manifest.fileName || !manifest.mimeType) {
      throw new GenerationProviderError({
        message: `MockProvider result is not ready (${manifest.status}).`,
        code: "MOCK_RESULT_NOT_READY",
        retryable: true,
        submissionUnknown: true,
      });
    }
    const outputStat = await stat(manifest.outputPath);
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error("MockProvider artifact is missing or empty.");
    const artifact: ProviderArtifact = {
      sourcePath: manifest.outputPath,
      fileName: manifest.fileName,
      mimeType: manifest.mimeType,
      outputIndex: 0,
      metadata: { mockMode: this.mode, attemptNumber: manifest.attemptNumber },
    };
    // Exercise result deduplication: the repeated output has the same stable provider index.
    return this.mode === "DUPLICATE_RESULT" ? [artifact, { ...artifact }] : [artifact];
  }

  async cancelGeneration(providerJobId: string): Promise<void> {
    const manifest = await this.findManifestByProviderJobId(providerJobId);
    if (!manifest) return;
    if (manifest.status === "SUCCEEDED" || manifest.status === "FAILED") return;
    await this.writeManifest({ ...manifest, status: "CANCELLED", updatedAt: new Date().toISOString() });
  }

  async countPersistedGenerations(): Promise<number> {
    const directory = path.join(this.rootDir, "records");
    try {
      const files = await readdir(directory);
      return files.filter((file) => file.endsWith(".json")).length;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  private async readManifest(providerRequestKey: string): Promise<MockManifest | null> {
    const manifestPath = this.manifestPath(providerRequestKey);
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as MockManifest;
      if (parsed.providerRequestKey !== providerRequestKey) throw new Error("MockProvider request-key manifest mismatch.");
      return parsed;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async findManifestByProviderJobId(providerJobId: string): Promise<MockManifest | null> {
    if (!/^mock-[a-f0-9]{64}$/.test(providerJobId)) return null;
    const filePath = path.join(this.rootDir, "records", `${providerJobId.slice(5)}.json`);
    try {
      const manifest = JSON.parse(await readFile(filePath, "utf8")) as MockManifest;
      if (manifest.providerJobId !== providerJobId) throw new Error("MockProvider job ID manifest mismatch.");
      return manifest;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async writeManifest(manifest: MockManifest): Promise<void> {
    const destination = this.manifestPath(manifest.providerRequestKey);
    await mkdir(path.dirname(destination), { recursive: true });
    const existing = await this.readManifest(manifest.providerRequestKey);
    if (existing && existing.providerJobId !== manifest.providerJobId) {
      throw new Error("Conflicting MockProvider provider job ID for an existing request key.");
    }
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      // The manifest is small; same-directory rename atomically publishes each state change.
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private manifestPath(providerRequestKey: string): string {
    return path.join(this.rootDir, "records", `${hashText(providerRequestKey)}.json`);
  }
}

function makeMockPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const pixels = Buffer.from([
    0, 0x20, 0x80, 0xe0, 0xff, 0xf0, 0x30, 0x40, 0xff,
    0, 0x10, 0x30, 0x80, 0xff, 0xf0, 0xf0, 0x20, 0xff,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeDeterministicFile(destination: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readFile(destination);
      if (!existing.equals(bytes)) throw new Error(`MockProvider output conflict at ${destination}`);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
