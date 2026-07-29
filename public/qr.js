'use strict';

/**
 * Generateur de QR code, sans dependance.
 *
 * Mode octet, correction d'erreur niveau L, versions 1 a 9 — largement de quoi
 * contenir un lien de transfert, cle comprise (232 octets au maximum).
 *
 * Sert a ouvrir un transfert sur un telephone depuis un ordinateur.
 */

// Nombre de mots de code de donnees, par version (index 0 = version 1).
const QR_DATA_CODEWORDS = [19, 34, 55, 80, 108, 136, 156, 194, 232];
// Mots de code de correction par bloc.
const QR_EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30];
// Nombre de blocs : un seul jusqu'a la version 5, deux ensuite.
const QR_BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2];
// Centres des motifs d'alignement (aucun en version 1).
const QR_ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46]];

// --- Arithmetique dans GF(256) ----------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // polynome generateur des QR codes
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Polynome generateur de degre `degree`. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Mots de code de correction d'erreur pour un bloc de donnees. */
function rsEncode(data, ecLength) {
  const generator = rsGenerator(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i++) {
      remainder[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return remainder;
}

// --- Codes BCH (information de format et de version) ------------------------

/**
 * Reste de la division polynomiale de `value` par `generator` dans GF(2).
 *
 * `dataBits` est le nombre de bits utiles en tete et `checkBits` le degre du
 * generateur : on annule les bits de poids fort un a un, du plus haut au plus
 * bas, et il ne subsiste que les bits de controle.
 */
function bchRemainder(value, generator, dataBits, checkBits) {
  let rest = value;
  for (let i = dataBits - 1; i >= 0; i--) {
    if (rest & (1 << (i + checkBits))) rest ^= generator << i;
  }
  return rest;
}

/** 15 bits : niveau de correction (L = 01) et numero de masque. */
function formatBits(mask) {
  const data = (0b01 << 3) | mask;
  const rest = bchRemainder(data << 10, 0b10100110111, 5, 10);
  return ((data << 10) | rest) ^ 0b101010000010010;
}

/** 18 bits, uniquement a partir de la version 7. */
function versionBits(version) {
  const rest = bchRemainder(version << 12, 0b1111100100101, 6, 12);
  return (version << 12) | rest;
}

// --- Construction de la matrice ---------------------------------------------

function isFunctionModule(version, size, row, col) {
  // Motifs de detection de position et separateurs
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= size - 8) return true;
  if (row >= size - 8 && col < 9) return true;
  // Motifs de synchronisation
  if (row === 6 || col === 6) return true;
  // Motifs d'alignement
  const centers = QR_ALIGNMENT[version - 1];
  for (const r of centers) {
    for (const c of centers) {
      if (r === 6 && c === 6) continue;
      if (r === 6 && c === centers[centers.length - 1]) continue;
      if (c === 6 && r === centers[centers.length - 1]) continue;
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
  }
  // Information de version
  if (version >= 7) {
    if (col < 6 && row >= size - 11 && row < size - 8) return true;
    if (row < 6 && col >= size - 11 && col < size - 8) return true;
  }
  return false;
}

function placeFunctionPatterns(matrix, version, size) {
  const setFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const outer = r >= 0 && r <= 6 && (c === 0 || c === 6)
          || c >= 0 && c <= 6 && (r === 0 || r === 6);
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[row][col] = outer || inner ? 1 : 0;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  const centers = QR_ALIGNMENT[version - 1];
  for (const r of centers) {
    for (const c of centers) {
      if (r === 6 && c === 6) continue;
      if (r === 6 && c === centers[centers.length - 1]) continue;
      if (c === 6 && r === centers[centers.length - 1]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.max(Math.abs(dr), Math.abs(dc));
          matrix[r + dr][c + dc] = edge === 1 ? 0 : 1;
        }
      }
    }
  }

  matrix[size - 8][8] = 1; // module toujours noir

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      matrix[row][col] = bit;
      matrix[col][row] = bit;
    }
  }
}

function placeFormat(matrix, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> i) & 1;
    // copie autour du motif superieur gauche
    if (i < 6) matrix[8][i] = bit;
    else if (i === 6) matrix[8][7] = bit;
    else if (i === 7) matrix[8][8] = bit;
    else if (i === 8) matrix[7][8] = bit;
    else matrix[14 - i][8] = bit;
    // copie de secours
    if (i < 8) matrix[size - 1 - i][8] = bit;
    else matrix[8][size - 15 + i] = bit;
  }
}

function maskAt(mask, row, col) {
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

/** Regles de penalite de la norme : sert a choisir le masque le plus lisible. */
function penalty(matrix, size) {
  let score = 0;

  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const current = horizontal ? matrix[i][j] : matrix[j][i];
        const previous = horizontal ? matrix[i][j - 1] : matrix[j - 1][i];
        if (current === previous) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (cells, at) => {
    for (let k = 0; k < 7; k++) if (cells[at + k] !== pattern[k]) return false;
    const before = cells.slice(Math.max(0, at - 4), at);
    const after = cells.slice(at + 7, at + 11);
    return (before.length === 4 && before.every((v) => v === 0))
      || (after.length === 4 && after.every((v) => v === 0));
  };
  for (let i = 0; i < size; i++) {
    const row = matrix[i];
    const col = matrix.map((line) => line[i]);
    for (let j = 0; j + 7 <= size; j++) {
      if (matches(row, j)) score += 40;
      if (matches(col, j)) score += 40;
    }
  }

  let dark = 0;
  for (const row of matrix) for (const cell of row) dark += cell;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

// --- Point d'entree ----------------------------------------------------------

/**
 * @param {string} text
 * @returns {number[][]} matrice de 0 et de 1, sans marge
 */
function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);

  const version = QR_DATA_CODEWORDS.findIndex((capacity) => bytes.length + 2 <= capacity) + 1;
  if (!version) throw new Error('Texte trop long pour un QR code de version 9.');

  const totalData = QR_DATA_CODEWORDS[version - 1];
  const size = 17 + version * 4;

  // --- flux binaire : mode octet, longueur, donnees, terminaison
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8); // longueur sur 8 bits jusqu'a la version 9
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, totalData * 8 - bits.length));
  while (bits.length % 8) bits.push(0);

  const data = new Uint8Array(totalData);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data[i / 8] = byte;
  }
  // remplissage normalise jusqu'a la capacite de la version
  const padding = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalData; i++, p++) {
    data[i] = padding[p % 2];
  }

  // --- decoupage en blocs, correction d'erreur, entrelacement
  const blockCount = QR_BLOCKS[version - 1];
  const ecLength = QR_EC_PER_BLOCK[version - 1];
  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blockCount; b++) {
    const length = shortLength + (b >= blockCount - longCount ? 1 : 0);
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLength));
  }

  const codewords = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) codewords.push(block[i]);
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) codewords.push(block[i]);
  }

  // --- placement en zigzag depuis le coin inferieur droit
  const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  placeFunctionPatterns(matrix, version, size);

  const reserved = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => isFunctionModule(version, size, r, c)));

  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // la colonne 6 est un motif de synchronisation
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        matrix[row][col] = nextBit();
      }
    }
    upward = !upward;
  }

  // --- choix du masque
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = matrix.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskAt(mask, r, c)) candidate[r][c] ^= 1;
      }
    }
    placeFormat(candidate, size, mask);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }

  return best.matrix;
}

/**
 * Rend le QR code sous forme de SVG autonome.
 *
 * La marge de 4 modules est exigee par la norme : certains lecteurs refusent
 * de decoder sans elle. La taille par defaut donne environ 5 pixels par module,
 * en deca desquels un appareil photo de telephone peine a distinguer la trame.
 */
function qrSvg(text, { margin = 4, size = 240 } = {}) {
  const matrix = qrMatrix(text);
  const modules = matrix.length + margin * 2;
  const path = [];
  for (let r = 0; r < matrix.length; r++) {
    for (let c = 0; c < matrix.length; c++) {
      if (matrix[r][c]) path.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} ${modules}" `
    + `width="${size}" height="${size}" role="img" aria-label="QR code du lien" `
    + `shape-rendering="crispEdges">`
    + `<rect width="${modules}" height="${modules}" fill="#fff"/>`
    + `<path d="${path.join('')}" fill="#000"/></svg>`;
}

if (typeof module !== 'undefined' && module.exports) {
  // formatBits et versionBits sont exposes pour etre confrontes aux tables
  // publiees par la norme dans les tests.
  module.exports = { qrMatrix, qrSvg, formatBits, versionBits };
}
