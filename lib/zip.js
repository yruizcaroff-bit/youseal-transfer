'use strict';

/**
 * Generateur d'archive ZIP en streaming, sans dependance.
 * Methode "store" (aucune compression) : les fichiers transferes sont deja
 * compresses la plupart du temps, et le streaming reste O(1) en memoire.
 * Supporte ZIP64 (fichiers > 4 Go, archives > 4 Go, > 65535 entrees).
 */

const fs = require('fs');
const { PassThrough } = require('stream');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf, previous = 0) {
  let c = ~previous;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

const U32_MAX = 0xffffffff;

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/** Nettoie un nom pour l'interieur de l'archive (pas de chemin absolu ni de ..). */
function safeEntryName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 200) || 'fichier';
}

/** Evite deux entrees portant le meme nom dans l'archive. */
function dedupeNames(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    let name = safeEntryName(entry.name);
    if (seen.has(name.toLowerCase())) {
      const count = seen.get(name.toLowerCase()) + 1;
      seen.set(name.toLowerCase(), count);
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      name = `${base} (${count})${ext}`;
    } else {
      seen.set(name.toLowerCase(), 0);
    }
    return { ...entry, name };
  });
}

/** Taille exacte de l'archive produite pour ces entrees (permet Content-Length). */
function computeZipSize(entries) {
  const list = dedupeNames(entries);
  let total = 0;
  let offset = 0;
  let centralSize = 0;
  let needsZip64Global = list.length > 0xffff;

  for (const entry of list) {
    const nameLen = Buffer.byteLength(entry.name, 'utf8');
    const bigFile = entry.size >= U32_MAX;
    const localSize = 30 + nameLen + (bigFile ? 20 : 0);
    const descriptorSize = 16 + (bigFile ? 8 : 0);

    const bigOffset = offset >= U32_MAX;
    if (bigFile || bigOffset) needsZip64Global = true;

    let centralExtra = 0;
    if (bigFile || bigOffset) {
      centralExtra = 4 + (bigFile ? 16 : 0) + (bigOffset ? 8 : 0);
    }
    centralSize += 46 + nameLen + centralExtra;

    offset += localSize + entry.size + descriptorSize;
    total += localSize + entry.size + descriptorSize;
  }

  if (offset >= U32_MAX || centralSize >= U32_MAX) needsZip64Global = true;

  total += centralSize;
  if (needsZip64Global) total += 56 + 20; // EOCD64 + locator
  total += 22; // EOCD
  return total;
}

/**
 * @param {Array<{name: string, path: string, size: number, mtime?: Date}>} rawEntries
 * @returns {import('stream').Readable}
 */
function createZipStream(rawEntries) {
  const entries = dedupeNames(rawEntries);
  const out = new PassThrough({ highWaterMark: 1 << 20 });

  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (out.destroyed) return reject(new Error('flux ferme'));
      if (out.write(buf)) return resolve();
      const onDrain = () => {
        out.off('close', onClose);
        resolve();
      };
      const onClose = () => {
        out.off('drain', onDrain);
        reject(new Error('flux ferme'));
      };
      out.once('drain', onDrain);
      out.once('close', onClose);
    });

  async function build() {
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      const zip64 = entry.size >= U32_MAX;
      const { date, time } = dosDateTime(entry.mtime);
      const localOffset = offset;

      // --- En-tete local (taille/CRC inconnus -> descripteur apres les donnees)
      const extraLocal = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
      if (zip64) {
        extraLocal.writeUInt16LE(0x0001, 0);
        extraLocal.writeUInt16LE(16, 2);
        extraLocal.writeBigUInt64LE(0n, 4);
        extraLocal.writeBigUInt64LE(0n, 12);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(zip64 ? 45 : 20, 4); // version minimale
      local.writeUInt16LE(0x0808, 6); // bit 3 (descripteur) + bit 11 (UTF-8)
      local.writeUInt16LE(0, 8); // methode: store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // crc32 -> descripteur
      local.writeUInt32LE(zip64 ? U32_MAX : 0, 18);
      local.writeUInt32LE(zip64 ? U32_MAX : 0, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(extraLocal.length, 28);

      await write(Buffer.concat([local, nameBuf, extraLocal]));
      offset += local.length + nameBuf.length + extraLocal.length;

      // --- Donnees
      let crc = 0;
      let written = 0;
      const source = fs.createReadStream(entry.path, { highWaterMark: 1 << 20 });
      for await (const chunk of source) {
        crc = crc32(chunk, crc);
        written += chunk.length;
        await write(chunk);
      }
      offset += written;

      // --- Descripteur de donnees
      const descriptor = Buffer.alloc(zip64 ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      if (zip64) {
        descriptor.writeBigUInt64LE(BigInt(written), 8);
        descriptor.writeBigUInt64LE(BigInt(written), 16);
      } else {
        descriptor.writeUInt32LE(written, 8);
        descriptor.writeUInt32LE(written, 12);
      }
      await write(descriptor);
      offset += descriptor.length;

      central.push({ nameBuf, crc, size: written, localOffset, time, date, zip64 });
    }

    // --- Repertoire central
    const centralStart = offset;
    let needsZip64End = entries.length > 0xffff || centralStart >= U32_MAX;

    for (const item of central) {
      const bigSize = item.size >= U32_MAX;
      const bigOffset = item.localOffset >= U32_MAX;
      if (bigSize || bigOffset) needsZip64End = true;

      let extra = Buffer.alloc(0);
      if (bigSize || bigOffset) {
        const payloadSize = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
        extra = Buffer.alloc(4 + payloadSize);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(payloadSize, 2);
        let p = 4;
        if (bigSize) {
          extra.writeBigUInt64LE(BigInt(item.size), p); p += 8; // non compresse
          extra.writeBigUInt64LE(BigInt(item.size), p); p += 8; // compresse
        }
        if (bigOffset) {
          extra.writeBigUInt64LE(BigInt(item.localOffset), p);
        }
      }

      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(45, 4); // version d'ecriture
      head.writeUInt16LE(item.zip64 || bigSize || bigOffset ? 45 : 20, 6);
      head.writeUInt16LE(0x0808, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(item.time, 12);
      head.writeUInt16LE(item.date, 14);
      head.writeUInt32LE(item.crc, 16);
      head.writeUInt32LE(bigSize ? U32_MAX : item.size, 20);
      head.writeUInt32LE(bigSize ? U32_MAX : item.size, 24);
      head.writeUInt16LE(item.nameBuf.length, 28);
      head.writeUInt16LE(extra.length, 30);
      head.writeUInt16LE(0, 32); // commentaire
      head.writeUInt16LE(0, 34); // disque
      head.writeUInt16LE(0, 36); // attributs internes
      head.writeUInt32LE(0, 38); // attributs externes
      head.writeUInt32LE(bigOffset ? U32_MAX : item.localOffset, 42);

      await write(Buffer.concat([head, item.nameBuf, extra]));
      offset += head.length + item.nameBuf.length + extra.length;
    }

    const centralSize = offset - centralStart;
    if (centralSize >= U32_MAX) needsZip64End = true;

    if (needsZip64End) {
      const eocd64 = Buffer.alloc(56);
      eocd64.writeUInt32LE(0x06064b50, 0);
      eocd64.writeBigUInt64LE(44n, 4); // taille de cet enregistrement - 12
      eocd64.writeUInt16LE(45, 12);
      eocd64.writeUInt16LE(45, 14);
      eocd64.writeUInt32LE(0, 16);
      eocd64.writeUInt32LE(0, 20);
      eocd64.writeBigUInt64LE(BigInt(central.length), 24);
      eocd64.writeBigUInt64LE(BigInt(central.length), 32);
      eocd64.writeBigUInt64LE(BigInt(centralSize), 40);
      eocd64.writeBigUInt64LE(BigInt(centralStart), 48);
      await write(eocd64);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(offset), 8);
      locator.writeUInt32LE(1, 16);
      await write(locator);
      offset += eocd64.length + locator.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(Math.min(central.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(central.length, 0xffff), 10);
    eocd.writeUInt32LE(Math.min(centralSize, U32_MAX), 12);
    eocd.writeUInt32LE(Math.min(centralStart, U32_MAX), 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    out.end();
  }

  build().catch((err) => out.destroy(err));

  return out;
}

module.exports = { createZipStream, computeZipSize, crc32, safeEntryName };
