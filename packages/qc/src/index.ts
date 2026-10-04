import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import type { QCCheckEvidence, QCCheckStatus, QCStatus } from "@flowforge/core";
import { hashBytesSha256 } from "@flowforge/assets";

export const DETERMINISTIC_QC_VERSION = "deterministic-v1";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES = 64 * 1024 * 1024;
const CRC_TABLE = makeCrcTable();

export interface ValidateAssetInput {
  path: string;
  expectedMimeType: string;
  expectedSizeBytes: number;
  expectedChecksum: string;
}

export interface QCReport {
  status: QCStatus;
  validatorVersion: string;
  checks: Record<string, QCCheckEvidence>;
  detectedMimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  width?: number;
  height?: number;
}

export async function validateAssetFile(input: ValidateAssetInput): Promise<QCReport> {
  const checks: Record<string, QCCheckEvidence> = {};
  let bytes: Buffer | null = null;
  let fileSize: number | undefined;
  let checksum: string | undefined;
  let detectedMimeType: string | undefined;
  let width: number | undefined;
  let height: number | undefined;

  try {
    const fileStat = await stat(input.path);
    const exists = fileStat.isFile();
    checks.exists = check(exists, { expected: true, actual: exists });
    if (!exists) {
      checks.readable = check(false, { message: "Path is not a regular file." });
      return report(checks);
    }
    fileSize = fileStat.size;
    if (fileSize > MAX_ASSET_BYTES) {
      checks.readable = check(false, { actual: fileSize, message: `Asset exceeds ${MAX_ASSET_BYTES} byte QC limit.` });
      checks.file_size = check(false, { expected: input.expectedSizeBytes, actual: fileSize });
      checks.checksum = check(false, { message: "Checksum was not evaluated for an oversized file." }, "NOT_EVALUATED");
      checks.mime_type = check(false, { message: "MIME type was not evaluated for an oversized file." }, "NOT_EVALUATED");
      checks.dimensions = check(false, { message: "Image dimensions were not evaluated for an oversized file." }, "NOT_EVALUATED");
      return report(checks, { sizeBytes: fileSize });
    }
    bytes = await readFile(input.path);
    checks.readable = check(bytes.byteLength > 0, {
      expected: "non-empty readable file",
      actual: bytes.byteLength,
    });
  } catch (error) {
    checks.exists = checks.exists ?? check(false, { message: errorMessage(error) });
    checks.readable = check(false, { message: errorMessage(error) });
    checks.file_size = check(false, { expected: input.expectedSizeBytes, message: "File size unavailable." });
    checks.checksum = check(false, { message: "Checksum unavailable." });
    checks.mime_type = check(false, { message: "MIME type unavailable." });
    checks.dimensions = check(false, { message: "Dimensions unavailable." }, "NOT_EVALUATED");
    return report(checks);
  }

  if (!bytes || bytes.length === 0) {
    checks.readable = check(false, { message: "Asset is empty." });
    checks.file_size = check(fileSize === input.expectedSizeBytes, { expected: input.expectedSizeBytes, actual: fileSize });
    checks.checksum = check(false, { message: "Checksum not computed for an empty asset." });
    checks.mime_type = check(false, { message: "MIME type not detected for an empty asset." });
    checks.dimensions = check(false, { message: "Dimensions not available." }, "NOT_EVALUATED");
    return report(checks, { sizeBytes: fileSize });
  }

  checksum = hashBytesSha256(bytes);
  detectedMimeType = detectMimeType(bytes);
  checks.file_size = check(fileSize === input.expectedSizeBytes && fileSize > 0, {
    expected: input.expectedSizeBytes,
    actual: fileSize,
  });
  checks.checksum = check(checksum === input.expectedChecksum, {
    expected: input.expectedChecksum,
    actual: checksum,
  });

  const normalizedExpectedMime = normalizeMimeType(input.expectedMimeType);
  const normalizedDetectedMime = normalizeMimeType(detectedMimeType);
  checks.mime_type = check(normalizedExpectedMime === normalizedDetectedMime && normalizedDetectedMime !== "application/octet-stream", {
    expected: normalizedExpectedMime,
    actual: normalizedDetectedMime,
  });

  if (detectedMimeType.startsWith("image/")) {
    try {
      const dimensions = parseImageDimensions(bytes, detectedMimeType);
      if (!dimensions) {
        checks.dimensions = check(false, {
          actual: detectedMimeType,
          message: "Image dimensions are not supported for this format by deterministic QC v1.",
        }, "NOT_EVALUATED");
      } else {
        width = dimensions.width;
        height = dimensions.height;
        checks.dimensions = check(width > 0 && height > 0, {
          expected: "positive image dimensions",
          actual: `${width}x${height}`,
        });
      }
    } catch (error) {
      const imageFailure = errorMessage(error);
      checks.readable = check(false, { message: `Image structure validation failed: ${imageFailure}` });
      checks.dimensions = check(false, { message: imageFailure });
    }
  } else {
    checks.dimensions = check(true, {
      expected: "not applicable",
      actual: detectedMimeType,
      message: "Image dimensions are not applicable to this media type.",
    });
  }

  return report(checks, {
    detectedMimeType,
    sizeBytes: fileSize,
    checksum,
    width,
    height,
  });
}

export function detectMimeType(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(buffer, PNG_SIGNATURE)) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6) {
    const gif = buffer.subarray(0, 6).toString("ascii");
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return buffer.subarray(8, 12).toString("ascii") === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "video/webm";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  return "application/octet-stream";
}

interface ParsedImage {
  width: number;
  height: number;
}

function parseImageDimensions(bytes: Buffer, mimeType: string): ParsedImage | null {
  switch (mimeType) {
    case "image/png": return parsePng(bytes);
    case "image/jpeg": return parseJpeg(bytes);
    case "image/gif": return parseGif(bytes);
    case "image/webp": return parseWebp(bytes);
    case "image/bmp": return parseBmp(bytes);
    default: return null;
  }
}

function parseJpeg(bytes: Buffer): ParsedImage {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG signature.");
  let offset = 2;
  let dimensions: ParsedImage | undefined;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG marker alignment.");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment length.");
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("JPEG segment exceeds the file boundary.");
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 8) throw new Error("Invalid JPEG start-of-frame segment.");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      validateDimensions(width, height, "JPEG");
      dimensions = { width, height };
    }
    offset += segmentLength;
  }
  if (!dimensions || !sawScan || bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) < 0) {
    throw new Error("JPEG is missing dimensions, image scan data, or an end marker.");
  }
  return dimensions;
}

function parseGif(bytes: Buffer): ParsedImage {
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (bytes.length < 14 || (signature !== "GIF87a" && signature !== "GIF89a")) throw new Error("Invalid or truncated GIF.");
  if (bytes[bytes.length - 1] !== 0x3b) throw new Error("GIF trailer is missing.");
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  validateDimensions(width, height, "GIF");
  return { width, height };
}

function parseWebp(bytes: Buffer): ParsedImage {
  if (bytes.length < 20 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw new Error("Invalid WebP container.");
  }
  const declaredSize = bytes.readUInt32LE(4) + 8;
  if (declaredSize !== bytes.length) throw new Error("WebP RIFF size does not match the file length.");
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const next = dataEnd + (chunkSize & 1);
    if (dataEnd > bytes.length || next > bytes.length) throw new Error("WebP chunk exceeds the file boundary.");
    const data = bytes.subarray(dataStart, dataEnd);
    let dimensions: ParsedImage | undefined;
    if (chunkType === "VP8X" && data.length >= 10) {
      dimensions = { width: readUInt24LE(data, 4) + 1, height: readUInt24LE(data, 7) + 1 };
    } else if (chunkType === "VP8L" && data.length >= 5 && data[0] === 0x2f) {
      dimensions = {
        width: 1 + data[1]! + ((data[2]! & 0x3f) << 8),
        height: 1 + ((data[2]! & 0xc0) >> 6) + (data[3]! << 2) + ((data[4]! & 0x0f) << 10),
      };
    } else if (chunkType === "VP8 " && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
      dimensions = { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
    }
    if (dimensions) {
      validateDimensions(dimensions.width, dimensions.height, "WebP");
      return dimensions;
    }
    offset = next;
  }
  throw new Error("WebP image dimensions were not found.");
}

function parseBmp(bytes: Buffer): ParsedImage {
  if (bytes.length < 26 || bytes.subarray(0, 2).toString("ascii") !== "BM") throw new Error("Invalid or truncated BMP.");
  const headerSize = bytes.readUInt32LE(14);
  let width: number;
  let height: number;
  if (headerSize >= 40) {
    if (bytes.length < 54) throw new Error("Truncated BMP info header.");
    width = Math.abs(bytes.readInt32LE(18));
    height = Math.abs(bytes.readInt32LE(22));
  } else if (headerSize === 12) {
    width = bytes.readUInt16LE(18);
    height = bytes.readUInt16LE(20);
  } else {
    throw new Error(`Unsupported BMP DIB header size: ${headerSize}`);
  }
  validateDimensions(width, height, "BMP");
  return { width, height };
}

function isJpegStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function validateDimensions(width: number, height: number, format: string): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) {
    throw new Error(`${format} dimensions are out of bounds.`);
  }
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function parsePng(bytes: Buffer): ParsedImage {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new Error("Invalid PNG signature.");
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataFinished = false;
  let sawEnd = false;
  const idat: Buffer[] = [];

  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > MAX_ASSET_BYTES || offset + 12 + chunkLength > bytes.length) {
      throw new Error("PNG chunk exceeds the file boundary.");
    }
    const chunkTypeBytes = bytes.subarray(offset + 4, offset + 8);
    const chunkType = chunkTypeBytes.toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      throw new Error(`PNG ${chunkType} chunk CRC mismatch.`);
    }

    if (!sawHeader && chunkType !== "IHDR") throw new Error("PNG must begin with an IHDR chunk.");
    if (chunkType === "IHDR") {
      if (sawHeader || chunkLength !== 13) throw new Error("Invalid PNG IHDR chunk.");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) throw new Error("Unsupported PNG compression or filter method.");
      interlace = data[12];
      if (width < 1 || height < 1 || width * height > 16_000_000) throw new Error("PNG dimensions are out of bounds.");
      sawHeader = true;
    } else if (chunkType === "PLTE") {
      if (sawPalette || sawImageData || chunkLength < 3 || chunkLength > 768 || chunkLength % 3 !== 0) {
        throw new Error("Invalid PNG palette chunk.");
      }
      if (colorType === 0 || colorType === 4) throw new Error("PNG palette is not valid for this color type.");
      sawPalette = true;
    } else if (chunkType === "IDAT") {
      if (imageDataFinished) throw new Error("PNG IDAT chunks must be consecutive.");
      if (colorType === 3 && !sawPalette) throw new Error("Indexed PNG is missing its palette.");
      sawImageData = true;
      idat.push(data);
    } else if (chunkType === "IEND") {
      if (chunkLength !== 0 || !sawImageData) throw new Error("Invalid or premature PNG IEND chunk.");
      sawEnd = true;
      offset = dataEnd + 4;
      break;
    } else {
      if (sawImageData) imageDataFinished = true;
      if (/^[A-Z]/.test(chunkType) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(chunkType)) {
        throw new Error(`Unsupported critical PNG chunk: ${chunkType}`);
      }
    }
    offset = dataEnd + 4;
  }

  if (!sawHeader || !sawEnd || idat.length === 0 || offset !== bytes.length) {
    throw new Error("PNG is truncated or has no complete image data.");
  }
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported by deterministic QC v1.");
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const allowedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = channelsByColorType[colorType];
  if (!channels || !allowedDepths[colorType]?.includes(bitDepth)) throw new Error("Unsupported PNG color type or bit depth.");

  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedInflatedLength = (rowBytes + 1) * height;
  if (expectedInflatedLength > MAX_DECODED_PNG_BYTES) throw new Error("Decoded PNG exceeds the QC memory limit.");
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_DECODED_PNG_BYTES });
  if (inflated.length !== expectedInflatedLength) throw new Error("PNG decompressed pixel data length is invalid.");
  for (let row = 0; row < height; row += 1) {
    if (inflated[row * (rowBytes + 1)]! > 4) throw new Error(`PNG row ${row} has an invalid filter type.`);
  }
  return { width, height };
}

function report(
  checks: Record<string, QCCheckEvidence>,
  details: Omit<QCReport, "status" | "validatorVersion" | "checks"> = {},
): QCReport {
  const statuses = Object.values(checks).map((result) => result.status);
  const status: QCStatus = statuses.includes("FAIL")
    ? "FAILED"
    : statuses.includes("NOT_EVALUATED")
      ? "NOT_EVALUATED"
      : "PASSED";
  return { status, validatorVersion: DETERMINISTIC_QC_VERSION, checks, ...details };
}

function check(
  passed: boolean,
  evidence: Omit<QCCheckEvidence, "status">,
  forcedStatus?: QCCheckStatus,
): QCCheckEvidence {
  return { status: forcedStatus ?? (passed ? "PASS" : "FAIL"), ...evidence };
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function startsWith(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
