'use strict';

/**
 * Archive ZIP produite dans le navigateur (ou le Service Worker), en flux.
 *
 * Meme format que lib/zip.js cote serveur : methode "store", descripteurs de
 * donnees, ZIP64 au besoin. Ici les octets proviennent du dechiffrement, le
 * serveur etant incapable de lire les fichiers.
 */

// En Node (tests), fdcrypto.js n'expose pas ses fonctions globalement : on les
// recupere explicitement. Dans le navigateur, les deux scripts partagent la
// meme portee globale et ce bloc est ignore.
if (typeof module !== 'undefined' && module.exports && typeof fdStreamFrom === 'undefined') {
  Object.assign(globalThis, require('./fdcrypto'));
}

const FD_ZIP_CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function fdCrc32(bytes, previous = 0) {
  let c = ~previous;
  for (let i = 0; i < bytes.length; i++) c = FD_ZIP_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const FD_U32_MAX = 0xffffffff;

function fdDosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function fdZipSafeName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 200) || 'fichier';
}

/** Deux fichiers homonymes ne peuvent pas coexister dans une archive. */
function fdZipNames(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    let name = fdZipSafeName(entry.name);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const count = seen.get(key) + 1;
      seen.set(key, count);
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      name = `${base} (${count})${ext}`;
    } else {
      seen.set(key, 0);
    }
    return { ...entry, name };
  });
}

/** Taille exacte de l'archive : permet d'annoncer Content-Length. */
function fdZipSize(rawEntries) {
  const entries = fdZipNames(rawEntries);
  let total = 0;
  let offset = 0;
  let central = 0;
  let zip64 = entries.length > 0xffff;

  for (const entry of entries) {
    const nameLen = new TextEncoder().encode(entry.name).length;
    const bigFile = entry.size >= FD_U32_MAX;
    const localSize = 30 + nameLen + (bigFile ? 20 : 0);
    const descriptorSize = 16 + (bigFile ? 8 : 0);
    const bigOffset = offset >= FD_U32_MAX;
    if (bigFile || bigOffset) zip64 = true;

    central += 46 + nameLen + (bigFile || bigOffset ? 4 + (bigFile ? 16 : 0) + (bigOffset ? 8 : 0) : 0);
    offset += localSize + entry.size + descriptorSize;
    total += localSize + entry.size + descriptorSize;
  }

  if (offset >= FD_U32_MAX || central >= FD_U32_MAX) zip64 = true;
  total += central;
  if (zip64) total += 56 + 20;
  return total + 22;
}

/**
 * @param {Array<{name: string, size: number, mtime?: Date}>} rawEntries
 * @param {(entry: object, index: number) => Promise<ReadableStream<Uint8Array>>} open
 * @returns {ReadableStream<Uint8Array>}
 */
function fdCreateZipStream(rawEntries, open) {
  const entries = fdZipNames(rawEntries);

  async function* generate() {
    const central = [];
    let offset = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const nameBytes = new TextEncoder().encode(entry.name);
      const zip64 = entry.size >= FD_U32_MAX;
      const { date, time } = fdDosDateTime(entry.mtime);
      const localOffset = offset;

      const header = new Uint8Array(30 + nameBytes.length + (zip64 ? 20 : 0));
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, zip64 ? 45 : 20, true);
      view.setUint16(6, 0x0808, true); // descripteur de donnees + UTF-8
      view.setUint16(8, 0, true);      // store
      view.setUint16(10, time, true);
      view.setUint16(12, date, true);
      view.setUint32(14, 0, true);
      view.setUint32(18, zip64 ? FD_U32_MAX : 0, true);
      view.setUint32(22, zip64 ? FD_U32_MAX : 0, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, zip64 ? 20 : 0, true);
      header.set(nameBytes, 30);
      if (zip64) {
        const extra = new DataView(header.buffer, 30 + nameBytes.length, 20);
        extra.setUint16(0, 0x0001, true);
        extra.setUint16(2, 16, true);
        extra.setBigUint64(4, 0n, true);
        extra.setBigUint64(12, 0n, true);
      }
      yield header;
      offset += header.length;

      let crc = 0;
      let written = 0;
      const reader = (await open(entry, i)).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        crc = fdCrc32(value, crc);
        written += value.length;
        yield value;
      }
      offset += written;

      const descriptor = new Uint8Array(zip64 ? 24 : 16);
      const dv = new DataView(descriptor.buffer);
      dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(4, crc, true);
      if (zip64) {
        dv.setBigUint64(8, BigInt(written), true);
        dv.setBigUint64(16, BigInt(written), true);
      } else {
        dv.setUint32(8, written, true);
        dv.setUint32(12, written, true);
      }
      yield descriptor;
      offset += descriptor.length;

      central.push({ nameBytes, crc, size: written, localOffset, time, date, zip64 });
    }

    // --- repertoire central
    const centralStart = offset;
    let zip64End = entries.length > 0xffff || centralStart >= FD_U32_MAX;

    for (const item of central) {
      const bigSize = item.size >= FD_U32_MAX;
      const bigOffset = item.localOffset >= FD_U32_MAX;
      if (bigSize || bigOffset) zip64End = true;

      const extraLen = bigSize || bigOffset ? 4 + (bigSize ? 16 : 0) + (bigOffset ? 8 : 0) : 0;
      const record = new Uint8Array(46 + item.nameBytes.length + extraLen);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 45, true);
      view.setUint16(6, item.zip64 || bigSize || bigOffset ? 45 : 20, true);
      view.setUint16(8, 0x0808, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, item.time, true);
      view.setUint16(14, item.date, true);
      view.setUint32(16, item.crc, true);
      view.setUint32(20, bigSize ? FD_U32_MAX : item.size, true);
      view.setUint32(24, bigSize ? FD_U32_MAX : item.size, true);
      view.setUint16(28, item.nameBytes.length, true);
      view.setUint16(30, extraLen, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, bigOffset ? FD_U32_MAX : item.localOffset, true);
      record.set(item.nameBytes, 46);

      if (extraLen) {
        const extra = new DataView(record.buffer, 46 + item.nameBytes.length, extraLen);
        extra.setUint16(0, 0x0001, true);
        extra.setUint16(2, extraLen - 4, true);
        let p = 4;
        if (bigSize) {
          extra.setBigUint64(p, BigInt(item.size), true); p += 8;
          extra.setBigUint64(p, BigInt(item.size), true); p += 8;
        }
        if (bigOffset) extra.setBigUint64(p, BigInt(item.localOffset), true);
      }

      yield record;
      offset += record.length;
    }

    const centralSize = offset - centralStart;
    if (centralSize >= FD_U32_MAX) zip64End = true;

    if (zip64End) {
      const tail = new Uint8Array(76);
      const view = new DataView(tail.buffer);
      view.setUint32(0, 0x06064b50, true);
      view.setBigUint64(4, 44n, true);
      view.setUint16(12, 45, true);
      view.setUint16(14, 45, true);
      view.setUint32(16, 0, true);
      view.setUint32(20, 0, true);
      view.setBigUint64(24, BigInt(central.length), true);
      view.setBigUint64(32, BigInt(central.length), true);
      view.setBigUint64(40, BigInt(centralSize), true);
      view.setBigUint64(48, BigInt(centralStart), true);
      view.setUint32(56, 0x07064b50, true);
      view.setUint32(60, 0, true);
      view.setBigUint64(64, BigInt(offset), true);
      view.setUint32(72, 1, true);
      yield tail;
      offset += tail.length;
    }

    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, Math.min(central.length, 0xffff), true);
    view.setUint16(10, Math.min(central.length, 0xffff), true);
    view.setUint32(12, Math.min(centralSize, FD_U32_MAX), true);
    view.setUint32(16, Math.min(centralStart, FD_U32_MAX), true);
    view.setUint16(20, 0, true);
    yield eocd;
  }

  return fdStreamFrom(generate());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fdZipSize, fdCreateZipStream, fdCrc32 };
}
