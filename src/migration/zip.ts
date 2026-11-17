import { entryPath } from './shared.js';

/** Validate the complete central directory before handing bytes to decompression. */
export function validateZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > bytes.length) throw new Error('数据包 ZIP 结构不完整');
    return view.getUint16(at, true);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > bytes.length) throw new Error('数据包 ZIP 结构不完整');
    return view.getUint32(at, true);
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = -1;
  for (let at = bytes.length - 22, minimum = Math.max(0, bytes.length - 22 - 65535); at >= minimum; at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw new Error('数据包不是完整的 ZIP 文件');
  const count = u16(end + 10), directorySize = u32(end + 12), directoryStart = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count)
    throw new Error('数据包不支持多卷 ZIP');
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff ||
    (end >= 20 && u32(end - 20) === 0x07064b50)) throw new Error('数据包不支持 ZIP64');
  if (count > 100_000 || directoryStart + directorySize !== end) throw new Error('数据包 ZIP 目录范围无效');
  const names = new Set<string>(), paths = new Map<string, 'file' | 'directory'>();
  const occupied: { start: number; end: number }[] = [];
  let cursor = directoryStart, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw new Error('数据包 ZIP 目录损坏');
    const flags = u16(cursor + 8), method = u16(cursor + 10);
    const compressed = u32(cursor + 20), original = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32);
    const local = u32(cursor + 42), external = u32(cursor + 38);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || (flags & 1) || ![0, 8].includes(method)) throw new Error('数据包使用未支持的 ZIP 条目');
    if (compressed === 0xffffffff || original === 0xffffffff || local === 0xffffffff || u16(cursor + 34))
      throw new Error('数据包不支持 ZIP64 或多卷条目');
    if (((external >>> 16) & 0xf000) === 0xa000) throw new Error('数据包不能含有符号链接');
    let filename: string;
    try { filename = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw new Error('数据包路径必须是 UTF-8 文本'); }
    const directory = filename.endsWith('/'), path = entryPath(directory ? filename.slice(0, -1) : filename);
    const folded = path.toLocaleLowerCase('en-US');
    if (names.has(folded)) throw new Error('数据包含重复或大小写冲突的路径');
    names.add(folded); paths.set(folded, directory ? 'directory' : 'file');
    total += original;
    if (original > 512 * 1024 * 1024 || total > 1024 * 1024 * 1024) throw new Error('数据包解压内容过大');
    if (method === 0 && compressed !== original) throw new Error('数据包条目大小不一致');
    let extra = cursor + 46 + nameLength;
    while (extra < cursor + 46 + nameLength + extraLength) {
      const id = u16(extra), size = u16(extra + 2);
      extra += 4 + size;
      if (extra > cursor + 46 + nameLength + extraLength || id === 1) throw new Error('数据包含有无效或 ZIP64 扩展');
    }
    if (local + 30 > directoryStart || u32(local) !== 0x04034b50) throw new Error('数据包 ZIP 本地条目损坏');
    const localNameLength = u16(local + 26), localExtraLength = u16(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
    if (dataEnd > directoryStart || u16(local + 6) !== flags || u16(local + 8) !== method ||
      localNameLength !== nameLength ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).every((byte, i) => byte === bytes[cursor + 46 + i]))
      throw new Error('数据包 ZIP 条目头不一致');
    if (!(flags & 8) && (u32(local + 18) !== compressed || u32(local + 22) !== original))
      throw new Error('数据包 ZIP 大小声明不一致');
    occupied.push({ start: local, end: dataEnd }); cursor = next;
  }
  if (cursor !== end) throw new Error('数据包 ZIP 目录条目计数不一致');
  occupied.sort((left, right) => left.start - right.start);
  for (let index = 1; index < occupied.length; index++)
    if (occupied[index]!.start < occupied[index - 1]!.end) throw new Error('数据包 ZIP 条目范围重叠');
  for (const [path] of paths) {
    const components = path.split('/');
    for (let index = 1; index < components.length; index++)
      if (paths.get(components.slice(0, index).join('/')) === 'file') throw new Error('数据包文件和目录路径冲突');
  }
}
