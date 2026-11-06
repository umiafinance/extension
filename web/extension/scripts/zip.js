import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// 1980-01-01 00:00 in DOS format: a fixed timestamp keeps the archive reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DEFLATE = 8;

function header(size, fields) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  for (const [bytes, value] of fields) {
    if (bytes === 4) buffer.writeUInt32LE(value, offset);
    else buffer.writeUInt16LE(value, offset);
    offset += bytes;
  }
  return buffer;
}

/** Deterministic ZIP: sorted paths, fixed timestamps, raw deflate, no extra fields. */
export function createZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { path, bytes } of sorted) {
    const name = Buffer.from(path, "utf8");
    const data = deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const common = [
      [2, 20],
      [2, 0x0800],
      [2, DEFLATE],
      [2, DOS_TIME],
      [2, DOS_DATE],
      [4, crc],
      [4, data.length],
      [4, bytes.length],
      [2, name.length],
      [2, 0],
    ];
    const local = header(30, [[4, 0x04034b50], ...common]);
    locals.push(local, name, data);
    centrals.push(
      header(46, [
        [4, 0x02014b50],
        [2, 20],
        ...common,
        [2, 0],
        [2, 0],
        [2, 0],
        [4, 0],
        [4, offset],
      ]),
      name,
    );
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = header(22, [
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, sorted.length],
    [2, sorted.length],
    [4, directory.length],
    [4, offset],
    [2, 0],
  ]);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads what createZip writes; anything else is rejected rather than half-parsed. */
export function readZip(zip) {
  const endOffset = zip.length - 22;
  if (endOffset < 0 || zip.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error("package is not a plain ZIP archive");
  }
  const count = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const path = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(start, start + compressedSize);
    let bytes = null;
    try {
      bytes = method === DEFLATE ? inflateRawSync(data) : method === 0 ? data : null;
    } catch {}
    if (!bytes || crc32(bytes) !== crc) throw new Error(`corrupt ZIP entry: ${path}`);
    entries.push({ path, bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
