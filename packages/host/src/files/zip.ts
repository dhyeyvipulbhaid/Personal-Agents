import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  data: Uint8Array;
};

/** Reads a zip of stored or deflated entries. Enough for a simple workbook. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 30 <= bytes.byteLength) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      break;
    }
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(
      bytes.subarray(nameStart, nameStart + nameLength),
    );
    const payload = bytes.subarray(dataStart, dataStart + compressed);
    const data = method === 0 ? payload : inflateRawSync(payload);
    entries.push({ name, data });
    offset = dataStart + compressed;
  }
  return entries;
}

/** Writes an uncompressed zip so tests can build a workbook without a library. */
export function writeStoredZip(
  files: { name: string; data: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + file.data.byteLength);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true);
    view.setUint32(18, file.data.byteLength, true);
    view.setUint32(22, file.data.byteLength, true);
    view.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.byteLength);
    parts.push(local);
    const record = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(record.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint32(20, file.data.byteLength, true);
    centralView.setUint32(24, file.data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.byteLength;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const total = offset + centralSize + end.byteLength;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
