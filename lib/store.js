'use strict';

/**
 * Stockage des transferts sur le disque.
 *
 *   storage/
 *     .secret                 cle HMAC (jetons d'acces)
 *     <transferId>/
 *       meta.json             metadonnees du transfert
 *       files/<fileId>        contenu binaire brut
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const ID_RE = /^[a-f0-9]{20,64}$/;

function randomId(bytes = 10) {
  return crypto.randomBytes(bytes).toString('hex');
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function transferDir(id) {
  if (!isValidId(id)) throw new Error('Identifiant invalide');
  return path.join(config.storageDir, id);
}

function filePath(id, fileId) {
  if (!isValidId(fileId)) throw new Error('Identifiant de fichier invalide');
  return path.join(transferDir(id), 'files', fileId);
}

// --- Mots de passe -----------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  try {
    const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch {
    return false;
  }
}

// --- Jetons d'acces (liens de telechargement proteges) -----------------------

let secret = null;

function getSecret() {
  if (secret) return secret;
  const file = path.join(config.storageDir, '.secret');
  try {
    secret = fs.readFileSync(file);
  } catch {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret;
}

function issueAccessToken(id) {
  const exp = Date.now() + config.accessTokenTtlMs;
  const payload = `${id}.${exp}`;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${exp}.${sig}`;
}

function verifyAccessToken(id, token) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const expected = crypto
    .createHmac('sha256', getSecret())
    .update(`${id}.${exp}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Cycle de vie ------------------------------------------------------------

async function init() {
  await fsp.mkdir(config.storageDir, { recursive: true });
  getSecret();
}

async function readTransfer(id) {
  if (!isValidId(id)) return null;
  try {
    const raw = await fsp.readFile(path.join(transferDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const locks = new Map();

/**
 * Serialise les modifications de meta.json d'un meme transfert.
 *
 * Sans cela, deux requetes simultanees lisent la meme valeur et ecrivent la
 * meme : un telechargement se perd, et la limite maxDownloads peut etre
 * depassee. La tache doit relire le transfert a l'interieur du verrou.
 */
function withTransferLock(id, task) {
  const previous = locks.get(id) || Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(() => {}, () => {});
  locks.set(id, settled);
  settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return result;
}

async function writeTransfer(transfer) {
  const dir = transferDir(transfer.id);
  const target = path.join(dir, 'meta.json');
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(transfer, null, 2));
  await fsp.rename(tmp, target);
}

/**
 * @param {{files: Array<{name: string, size: number, type?: string}>, message?: string,
 *          password?: string, expiryDays?: number, maxDownloads?: number}} input
 */
async function createTransfer(input) {
  const id = randomId(10);
  const dir = transferDir(id);
  await fsp.mkdir(path.join(dir, 'files'), { recursive: true });

  const expiryDays = Math.min(
    Math.max(Number(input.expiryDays) || config.defaultExpiryDays, 1),
    config.maxExpiryDays
  );

  const encrypted = Boolean(input.encrypted);

  const transfer = {
    id,
    ownerToken: randomId(24),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiryDays * 86400000).toISOString(),
    encrypted,
    // Transfert chiffre : noms, types et message sont dans le manifeste chiffre,
    // illisible par le serveur. Sinon, message en clair.
    manifest: encrypted ? String(input.manifest) : null,
    message: encrypted ? '' : String(input.message || '').slice(0, config.maxMessageLength),
    password: input.password ? hashPassword(input.password) : null,
    maxDownloads: Number(input.maxDownloads) > 0 ? Number(input.maxDownloads) : null,
    downloads: 0,
    complete: false,
    totalSize: input.files.reduce((sum, f) => sum + Number(f.size), 0),
    files: input.files.map((f, i) => ({
      id: randomId(10),
      // Aucune metadonnee client n'est conservee pour un transfert chiffre.
      name: encrypted ? `chiffre-${i + 1}.bin` : String(f.name).slice(0, 255),
      size: Number(f.size),
      type: encrypted ? 'application/octet-stream'
        : String(f.type || 'application/octet-stream').slice(0, 120),
      uploaded: 0,
      done: false,
    })),
  };

  await writeTransfer(transfer);
  return transfer;
}

async function deleteTransfer(id) {
  await fsp.rm(transferDir(id), { recursive: true, force: true });
}

function isExpired(transfer) {
  if (!transfer) return true;
  if (Date.parse(transfer.expiresAt) <= Date.now()) return true;
  if (transfer.maxDownloads && transfer.downloads >= transfer.maxDownloads) return true;
  return false;
}

/** Vue publique : sans jeton proprietaire ni empreinte de mot de passe. */
function publicView(transfer) {
  return {
    id: transfer.id,
    createdAt: transfer.createdAt,
    expiresAt: transfer.expiresAt,
    encrypted: Boolean(transfer.encrypted),
    manifest: transfer.manifest || null,
    message: transfer.message,
    protected: Boolean(transfer.password),
    downloads: transfer.downloads,
    maxDownloads: transfer.maxDownloads,
    totalSize: transfer.totalSize,
    files: transfer.files.map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.type })),
  };
}

/** Supprime les transferts expires ou abandonnes (crees et jamais finalises). */
async function cleanup() {
  let removed = 0;
  let entries;
  try {
    entries = await fsp.readdir(config.storageDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const transfer = await readTransfer(entry.name);
    if (!transfer) {
      // dossier orphelin (creation interrompue) : on purge apres 24 h
      try {
        const stat = await fsp.stat(path.join(config.storageDir, entry.name));
        if (Date.now() - stat.mtimeMs > 86400000) {
          await fsp.rm(path.join(config.storageDir, entry.name), { recursive: true, force: true });
          removed++;
        }
      } catch { /* ignore */ }
      continue;
    }

    const abandoned =
      !transfer.complete && Date.now() - Date.parse(transfer.createdAt) > 24 * 3600 * 1000;

    if (isExpired(transfer) || abandoned) {
      await deleteTransfer(transfer.id);
      removed++;
    }
  }
  return removed;
}

module.exports = {
  init,
  randomId,
  isValidId,
  transferDir,
  filePath,
  readTransfer,
  writeTransfer,
  withTransferLock,
  createTransfer,
  deleteTransfer,
  isExpired,
  publicView,
  cleanup,
  verifyPassword,
  issueAccessToken,
  verifyAccessToken,
};
