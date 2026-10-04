import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface StoreAssetInput {
  projectId: string;
  sceneId: string;
  generationJobId: string;
  outputIndex: number;
  sourcePath: string;
  fileName: string;
}

export interface StoredAssetFile {
  storagePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  checksum: string;
}

/** Local asset byte store. Metadata remains in SQLite; bytes use stable job/output paths. */
export class FileSystemAssetStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async importFile(input: StoreAssetInput): Promise<StoredAssetFile> {
    for (const [label, value] of [
      ["project ID", input.projectId],
      ["scene ID", input.sceneId],
      ["generation job ID", input.generationJobId],
    ] as const) {
      validatePathSegment(value, label);
    }
    if (!Number.isSafeInteger(input.outputIndex) || input.outputIndex < 0) {
      throw new Error("Asset output index must be a non-negative integer.");
    }

    const sourcePath = path.resolve(input.sourcePath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`Provider result is not a regular file: ${sourcePath}`);
    if (sourceStat.size <= 0) throw new Error(`Provider result is empty: ${sourcePath}`);

    const fileName = path.basename(input.fileName || sourcePath);
    const extension = normalizedExtension(fileName);
    const destinationDirectory = path.join(
      this.root,
      "projects",
      input.projectId,
      "scenes",
      input.sceneId,
      "generations",
      input.generationJobId,
    );
    await mkdir(destinationDirectory, { recursive: true });

    const destination = path.join(destinationDirectory, `output-${input.outputIndex}${extension}`);
    const sourceChecksum = await hashFileSha256(sourcePath);
    const existing = await existingFile(destination);
    if (existing) {
      if (existing.checksum !== sourceChecksum || existing.sizeBytes !== sourceStat.size) {
        throw new Error(`Immutable asset destination already contains different bytes: ${destination}`);
      }
      return {
        storagePath: destination,
        fileName: path.basename(destination),
        extension,
        sizeBytes: existing.sizeBytes,
        checksum: existing.checksum,
      };
    }

    const temporary = path.join(destinationDirectory, `.tmp-${randomUUID()}${extension}`);
    try {
      await copyFile(sourcePath, temporary);
      try {
        // Hard-link creation is atomic and fails rather than replacing a different existing result.
        await link(temporary, destination);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const raced = await existingFile(destination);
        if (!raced || raced.checksum !== sourceChecksum || raced.sizeBytes !== sourceStat.size) {
          throw new Error(`Concurrent asset write produced conflicting bytes: ${destination}`);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }

    const stored = await existingFile(destination);
    if (!stored || stored.checksum !== sourceChecksum || stored.sizeBytes !== sourceStat.size) {
      throw new Error(`Stored asset failed its post-write integrity check: ${destination}`);
    }
    return {
      storagePath: destination,
      fileName: path.basename(destination),
      extension,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
    };
  }

  async readFile(storagePath: string): Promise<Buffer> {
    const resolved = path.resolve(storagePath);
    if (!isInside(this.root, resolved)) throw new Error("Asset path is outside the configured asset root.");
    return readFile(resolved);
  }
}

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function hashBytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isPathInside(root: string, candidate: string): boolean {
  return isInside(path.resolve(root), path.resolve(candidate));
}

async function existingFile(filePath: string): Promise<{ sizeBytes: number; checksum: string } | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return null;
    return { sizeBytes: fileStat.size, checksum: await hashFileSha256(filePath) };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function normalizedExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  const allowed = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".mp4", ".mov", ".webm", ".wav", ".mp3", ".ogg"]);
  return allowed.has(extension) ? extension : ".bin";
}

function validatePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} contains unsupported path characters.`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
