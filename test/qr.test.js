'use strict';

/*
 * QR code.
 *
 * Aucun décodeur tiers n'est disponible ici : la vérification repose sur les
 * tables publiées par la norme (information de format et de version), sur un
 * décodage indépendant de la matrice, et sur les invariants de structure.
 */

const { qrMatrix, qrSvg } = require('../public/qr.js');

// Norme ISO/IEC 18004, table C.1 — niveau de correction L, masques 0 à 7.
const FORMAT_L = [
  '111011111000100', '111001011110011', '111110110101010', '111100010011101',
  '110011000101111', '110001100011000', '110110001000001', '110100101110110',
];

// Table D.1 — information de version, à partir de la version 7.
const VERSION_BITS = {
  7: '000111110010010100',
  8: '001000010110111100',
  9: '001001101010011001',
};

// --- Décodage indépendant de la matrice -------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

const DATA_CODEWORDS = [19, 34, 55, 80, 108, 136, 156, 194, 232];
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30];
const BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2];
const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46]];

function functionModule(version, size, row, col) {
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= size - 8) return true;
  if (row >= size - 8 && col < 9) return true;
  if (row === 6 || col === 6) return true;
  const centers = ALIGNMENT[version - 1];
  const last = centers[centers.length - 1];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (c === 6 && r === last)) continue;
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
  }
  if (version >= 7) {
    if (col < 6 && row >= size - 11 && row < size - 8) return true;
    if (row < 6 && col >= size - 11 && col < size - 8) return true;
  }
  return false;
}

function unmask(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** Relit le contenu d'une matrice : masque, entrelacement, syndromes, charge utile. */
function decode(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;

  // masque : lu dans l'information de format en bas à gauche
  let format = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 8 ? matrix[size - 1 - i][8] : matrix[8][size - 15 + i];
    format |= bit << i;
  }
  format ^= 0b101010000010010;
  const mask = (format >> 10) & 0b111;
  const ecLevel = (format >> 13) & 0b11;

  // lecture en zigzag
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (functionModule(version, size, row, col)) continue;
        bits.push(matrix[row][col] ^ (unmask(mask, row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }

  // dés-entrelacement
  const totalData = DATA_CODEWORDS[version - 1];
  const blockCount = BLOCKS[version - 1];
  const ecLength = EC_PER_BLOCK[version - 1];
  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;

  const lengths = [];
  for (let b = 0; b < blockCount; b++) {
    lengths.push(shortLength + (b >= blockCount - longCount ? 1 : 0));
  }
  const dataBlocks = lengths.map((n) => new Array(n));
  let index = 0;
  for (let i = 0; i < Math.max(...lengths); i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < lengths[b]) dataBlocks[b][i] = codewords[index++];
    }
  }
  const ecBlocks = Array.from({ length: blockCount }, () => []);
  for (let i = 0; i < ecLength; i++) {
    for (let b = 0; b < blockCount; b++) ecBlocks[b].push(codewords[index++]);
  }

  // syndromes : nuls si la correction d'erreur est cohérente
  let syndromesOk = true;
  for (let b = 0; b < blockCount; b++) {
    const full = [...dataBlocks[b], ...ecBlocks[b]];
    for (let s = 0; s < ecLength; s++) {
      let value = 0;
      for (const byte of full) value = mul(value, GF_EXP[s]) ^ byte;
      if (value !== 0) syndromesOk = false;
    }
  }

  // charge utile : mode 0100 (octet), longueur sur 8 bits
  const data = dataBlocks.flat();
  const mode = data[0] >> 4;
  const length = ((data[0] & 0x0f) << 4) | (data[1] >> 4);
  const bytes = [];
  for (let i = 0; i < length; i++) {
    bytes.push(((data[1 + i] & 0x0f) << 4) | (data[2 + i] >> 4));
  }

  return {
    version, mask, ecLevel, syndromesOk, mode,
    text: Buffer.from(bytes).toString('utf8'),
  };
}

// --- Suite -------------------------------------------------------------------

module.exports = function run({ assert }) {
  // Les tables de la norme valident les codes BCH.
  const { formatBits, versionBits } = require('../public/qr.js');

  const formats = [];
  for (let mask = 0; mask < 8; mask++) {
    formats.push(formatBits(mask).toString(2).padStart(15, '0'));
  }
  assert(formats.join(',') === FORMAT_L.join(','),
    `information de format conforme a la table C.1 (${formats[0]}…)`);

  for (const [version, expected] of Object.entries(VERSION_BITS)) {
    assert(versionBits(Number(version)).toString(2).padStart(18, '0') === expected,
      `information de version ${version} conforme a la table D.1`);
  }

  // Round-trip sur des charges utiles de tailles croissantes (versions 1 a 9).
  const payloads = [
    'A',
    'https://youseal.site',
    'https://youseal.site/t/0d4b66394c71988f713f#llkB0tTvY0AtHfld-jfnKCU8uu-Tapcd9BENN2NPMHE',
    'http://localhost:3000/t/0d4b66394c71988f713f#llkB0tTvY0AtHfld-jfnKCU8uu-Tapcd9BENN2NPMHE',
    'é'.repeat(60),
    'x'.repeat(200),
  ];

  for (const payload of payloads) {
    const matrix = qrMatrix(payload);
    const read = decode(matrix);
    const label = payload.length > 30 ? `${payload.slice(0, 27)}…` : payload;
    assert(read.text === payload && read.mode === 4,
      `relecture identique — version ${read.version}, masque ${read.mask} (${label})`);
    assert(read.syndromesOk, `syndromes de correction nuls (version ${read.version})`);
    assert(read.ecLevel === 0b01, `niveau de correction L annonce (version ${read.version})`);
  }

  // Invariants de structure sur un cas representatif.
  const matrix = qrMatrix('https://youseal.site');
  const size = matrix.length;
  assert(size === 17 + 4 * ((size - 17) / 4) && size % 4 === 1, `taille normalisee (${size} modules)`);

  const finderOk = [[0, 0], [0, size - 7], [size - 7, 0]].every(([top, left]) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (matrix[top + r][left + c] !== (ring || core ? 1 : 0)) return false;
      }
    }
    return true;
  });
  assert(finderOk, 'trois motifs de detection de position corrects');

  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (matrix[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  assert(timingOk, 'motifs de synchronisation alternes');
  assert(matrix[size - 8][8] === 1, 'module fixe noir present');

  const svg = qrSvg('https://youseal.site');
  assert(svg.startsWith('<svg') && svg.includes('viewBox') && svg.includes('</svg>'),
    'rendu SVG autonome');

  let tooLong = false;
  try { qrMatrix('x'.repeat(300)); } catch { tooLong = true; }
  assert(tooLong, 'refus explicite au-dela de la capacite');
};
