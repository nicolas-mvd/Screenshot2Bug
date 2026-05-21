import type { CaptureSession } from "./types";
import { normalizeSession } from "./storage";

export interface ReportZipInput {
  session: CaptureSession;
  report: string;
}

interface ZipFile {
  name: string;
  bytes: Uint8Array;
  modifiedAt: Date;
}

export async function buildReportZip({
  session,
  report
}: ReportZipInput): Promise<Blob> {
  const normalized = normalizeSession(session) ?? session;
  const modifiedAt = new Date(normalized.updatedAt || normalized.createdAt);
  const files: ZipFile[] = [
    { name: "report.md", bytes: textBytes(report), modifiedAt },
    {
      name: "metadata.json",
      bytes: textBytes(JSON.stringify(normalized, null, 2)),
      modifiedAt
    }
  ];

  for (const [index, screenshot] of (normalized.screenshots ?? []).entries()) {
    files.push({
      name: `screenshots/screenshot-${index + 1}.png`,
      bytes: dataUrlBytes(screenshot.dataUrl),
      modifiedAt: new Date(screenshot.createdAt || normalized.updatedAt || normalized.createdAt)
    });
  }

  for (const [index, recording] of (normalized.recordings ?? []).entries()) {
    files.push({
      name: `recordings/recording-${index + 1}.webm`,
      bytes: dataUrlBytes(recording.dataUrl),
      modifiedAt: new Date(recording.createdAt || normalized.updatedAt || normalized.createdAt)
    });
  }

  return createZip(files);
}

function createZip(files: ZipFile[]): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textBytes(file.name);
    const crc = crc32(file.bytes);
    const { time, date } = dosDateTime(file.modifiedAt);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.bytes.length, true);
    localView.setUint32(22, file.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.bytes.length, true);
    centralView.setUint32(24, file.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.bytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end] as BlobPart[], {
    type: "application/zip"
  });
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function dosDateTime(value: Date): { time: number; date: number } {
  const date = Number.isNaN(value.getTime()) ? new Date() : value;
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
