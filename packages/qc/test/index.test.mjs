import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { hashBytesSha256 } from "@flowforge/assets";
import { validateAssetFile } from "../dist/index.js";

const png = makePng(2, 2);

test("deterministic QC validates PNG readability, type, size, checksum, and dimensions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-qc-"));
  const filePath = path.join(directory, "image.png");
  await writeFile(filePath, png);
  try {
    const result = await validateAssetFile({
      path: filePath,
      expectedMimeType: "image/png",
      expectedSizeBytes: png.length,
      expectedChecksum: hashBytesSha256(png),
    });
    assert.equal(result.status, "PASSED");
    assert.equal(result.validatorVersion, "deterministic-v1");
    assert.deepEqual([result.width, result.height], [2, 2]);
    assert.equal(result.checks.exists.status, "PASS");
    assert.equal(result.checks.readable.status, "PASS");
    assert.equal(result.checks.mime_type.status, "PASS");
    assert.equal(result.checks.checksum.status, "PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("QC fails a checksum mismatch and an invalid PNG payload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-qc-invalid-"));
  const filePath = path.join(directory, "broken.png");
  const invalid = Buffer.from("not a png");
  await writeFile(filePath, invalid);
  try {
    const result = await validateAssetFile({
      path: filePath,
      expectedMimeType: "image/png",
      expectedSizeBytes: invalid.length,
      expectedChecksum: "0".repeat(64),
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.checks.checksum.status, "FAIL");
    assert.equal(result.checks.mime_type.status, "FAIL");
    assert.equal(result.checks.readable.status, "PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("QC extracts dimensions from JPEG, GIF, WebP, and BMP signatures", async () => {
  const fixtures = [
    ["jpeg", "image/jpeg", "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q=="],
    ["gif", "image/gif", "R0lGODlhAgACAPAAAP8AAAAAACH5BAAAAAAALAAAAAACAAIAAAIChFEAOw=="],
    ["webp", "image/webp", "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA="],
    ["bmp", "image/bmp", "Qk2aAAAAAAAAAIoAAAB8AAAAAgAAAAIAAAABABgAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAD/AAAAAAAA/0JHUnMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAAAAP8AAP8AAA=="],
  ];
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-qc-images-"));
  try {
    for (const [extension, mimeType, base64] of fixtures) {
      const bytes = Buffer.from(base64, "base64");
      const filePath = path.join(directory, `image.${extension}`);
      await writeFile(filePath, bytes);
      const result = await validateAssetFile({
        path: filePath,
        expectedMimeType: mimeType,
        expectedSizeBytes: bytes.length,
        expectedChecksum: hashBytesSha256(bytes),
      });
      assert.equal(result.status, "PASSED", `${extension}: ${JSON.stringify(result.checks)}`);
      assert.deepEqual([result.width, result.height], [2, 2], extension);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("QC reports missing assets and MIME mismatches as failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowforge-qc-missing-"));
  const filePath = path.join(directory, "missing.png");
  try {
    const missing = await validateAssetFile({
      path: filePath,
      expectedMimeType: "image/png",
      expectedSizeBytes: png.length,
      expectedChecksum: hashBytesSha256(png),
    });
    assert.equal(missing.status, "FAILED");
    assert.equal(missing.checks.exists.status, "FAIL");

    await writeFile(filePath, png);
    const wrongMime = await validateAssetFile({
      path: filePath,
      expectedMimeType: "image/jpeg",
      expectedSizeBytes: png.length,
      expectedChecksum: hashBytesSha256(png),
    });
    assert.equal(wrongMime.status, "FAILED");
    assert.equal(wrongMime.checks.mime_type.status, "FAIL");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, 0x20, 0x80, 0xe0, 0xff, 0xf0, 0x30, 0x40, 0xff]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
