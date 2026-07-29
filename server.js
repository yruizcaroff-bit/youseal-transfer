'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const config = require('./lib/config');
const store = require('./lib/store');
const stats = require('./lib/stats');
const limits = require('./lib/limits');
const pairing = require('./lib/pairing');
const prune = require('./lib/prune');
const { createZipStream, computeZipSize } = require('./lib/zip');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// --- Helpers HTTP ------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

/** 429 avec l'en-tete Retry-After, pour les limites d'usage. */
function failRate(res, retryAfter, message) {
  const payload = JSON.stringify({ error: message, retryAfter });
  res.writeHead(429, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'retry-after': String(retryAfter),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function minutesLabel(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return minutes > 1 ? `${minutes} minutes` : 'une minute';
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Corps de requete trop volumineux'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON invalide'), { status: 400 });
  }
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function publicBaseUrl(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

async function serveStatic(res, relPath) {
  const target = path.join(PUBLIC_DIR, relPath);
  if (!target.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Acces refuse');
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 - Introuvable');
  }
}

// --- Autorisations -----------------------------------------------------------

function isOwner(req, url, transfer) {
  const token = req.headers['x-owner-token'] || url.searchParams.get('owner');
  return timingSafeEquals(token, transfer.ownerToken);
}

/** Verifie qu'on peut consulter/telecharger un transfert protege. */
function hasAccess(req, url, transfer) {
  if (!transfer.password) return true;
  const password = req.headers['x-transfer-password'];
  if (password && store.verifyPassword(String(password), transfer.password)) return true;
  const token = req.headers['x-access-token'] || url.searchParams.get('k');
  return store.verifyAccessToken(transfer.id, token);
}

/** Charge un transfert et gere les cas 404 / expire. */
async function loadTransfer(res, id) {
  const transfer = await store.readTransfer(id);
  if (!transfer) {
    fail(res, 404, 'Ce transfert n\'existe pas ou a ete supprime.');
    return null;
  }
  if (store.isExpired(transfer)) {
    await store.deleteTransfer(id).catch(() => {});
    stats.transferRemoved(transfer);
    fail(res, 410, 'Ce transfert a expire.');
    return null;
  }
  return transfer;
}

// --- Routes API --------------------------------------------------------------

async function createTransferRoute(req, res) {
  const gate = limits.createTransfer(req);
  if (!gate.ok) {
    return failRate(res, gate.retryAfter,
      `Trop de transferts crees depuis cette adresse. Reessayez dans ${minutesLabel(gate.retryAfter)}.`);
  }

  const body = await readJsonBody(req);
  const files = Array.isArray(body.files) ? body.files : [];

  if (!files.length) return fail(res, 400, 'Aucun fichier a envoyer.');
  if (files.length > config.maxFilesPerTransfer) {
    return fail(res, 400, `Maximum ${config.maxFilesPerTransfer} fichiers par transfert.`);
  }

  const encrypted = Boolean(body.encrypted);
  if (encrypted) {
    if (typeof body.manifest !== 'string' || !body.manifest ||
        body.manifest.length > config.maxManifestLength ||
        !/^[A-Za-z0-9_-]+$/.test(body.manifest)) {
      return fail(res, 400, 'Manifeste chiffre invalide.');
    }
  }

  let total = 0;
  for (const file of files) {
    const size = Number(file.size);
    if ((!encrypted && !file.name) || !Number.isFinite(size) || size < 0) {
      return fail(res, 400, 'Description de fichier invalide.');
    }
    if (size > config.maxFileSize) {
      return fail(res, 413, encrypted
        ? 'Un fichier depasse la taille maximale autorisee.'
        : `"${file.name}" depasse la taille maximale par fichier.`);
    }
    total += size;
  }
  if (total > config.maxTransferSize) {
    return fail(res, 413, 'Le transfert depasse la taille totale autorisee.');
  }

  // Quota global : la place est engagee des la creation, avant reception.
  if (stats.reservedBytes() + total > config.maxStorage) {
    return fail(res, 507, 'Le service a atteint sa capacite de stockage. Reessayez plus tard.');
  }

  const transfer = await store.createTransfer({
    files,
    encrypted,
    manifest: body.manifest,
    message: body.message,
    password: body.password ? String(body.password) : null,
    expiryDays: body.expiryDays,
    maxDownloads: body.maxDownloads,
    burnAfterReading: body.burnAfterReading,
  });
  stats.transferCreated(transfer);

  sendJson(res, 201, {
    id: transfer.id,
    ownerToken: transfer.ownerToken,
    expiresAt: transfer.expiresAt,
    files: transfer.files.map((f) => ({ id: f.id, name: f.name, size: f.size })),
  });

  // La purge parcourt tout le stockage : on ne fait pas attendre l'expediteur.
  prune.pruneIfNeeded(store, stats).catch((err) => console.error('[purge]', err));
}

async function uploadFileRoute(req, res, url, id, fileId) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!isOwner(req, url, transfer)) return fail(res, 403, 'Jeton d\'envoi invalide.');
  if (transfer.complete) return fail(res, 409, 'Ce transfert est deja finalise.');

  const entry = transfer.files.find((f) => f.id === fileId);
  if (!entry) return fail(res, 404, 'Fichier inconnu dans ce transfert.');

  const target = store.filePath(id, fileId);
  let current = 0;
  try {
    current = (await fsp.stat(target)).size;
  } catch { /* pas encore de fichier */ }

  const offset = Number(req.headers['x-upload-offset'] || 0);
  if (!Number.isFinite(offset) || offset < 0 || offset > current) {
    return sendJson(res, 409, { error: 'Decalage d\'envoi invalide.', offset: current });
  }
  // Reprise apres coupure : on tronque le bloc partiel avant de reprendre.
  // Indispensable pour le chiffrement, ou les blocs doivent rester alignes.
  if (offset < current) {
    await fsp.truncate(target, offset);
    current = offset;
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (offset + declared > entry.size) {
    return fail(res, 400, 'Les donnees envoyees depassent la taille annoncee.');
  }

  const out = fs.createWriteStream(target, { flags: offset > 0 ? 'a' : 'w' });
  try {
    await pipeline(req, out);
  } catch {
    // connexion interrompue : la reprise se fera via x-upload-offset
    return;
  }

  const size = (await fsp.stat(target)).size;
  const done = size === entry.size;

  // Deux fichiers d'un meme transfert peuvent etre envoyes en parallele :
  // la relecture sous verrou evite qu'une progression en ecrase une autre.
  await store.withTransferLock(id, async () => {
    const fresh = await store.readTransfer(id);
    if (!fresh) return;
    const current = fresh.files.find((f) => f.id === fileId);
    if (!current) return;
    current.uploaded = size;
    current.done = done;
    await store.writeTransfer(fresh);
  });

  sendJson(res, 200, { id: entry.id, uploaded: size, done });
}

/** Etat d'envoi d'un fichier : permet a l'expediteur de reprendre apres coupure. */
async function fileStatusRoute(req, res, url, id, fileId) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!isOwner(req, url, transfer)) return fail(res, 403, 'Jeton d\'envoi invalide.');

  const entry = transfer.files.find((f) => f.id === fileId);
  if (!entry) return fail(res, 404, 'Fichier inconnu dans ce transfert.');

  let uploaded = 0;
  try {
    uploaded = (await fsp.stat(store.filePath(id, fileId))).size;
  } catch { /* rien d'envoye */ }

  sendJson(res, 200, { id: entry.id, uploaded, size: entry.size, done: uploaded === entry.size });
}

async function completeTransferRoute(req, res, url, id) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!isOwner(req, url, transfer)) return fail(res, 403, 'Jeton d\'envoi invalide.');

  const finalised = await store.withTransferLock(id, async () => {
    const fresh = await store.readTransfer(id);
    if (!fresh) return null;
    if (fresh.files.some((f) => !f.done)) return 'incomplet';
    if (fresh.complete) return fresh; // finalisation deja faite
    fresh.complete = true;
    fresh.completedAt = new Date().toISOString();
    await store.writeTransfer(fresh);
    stats.transferCompleted(fresh);
    return fresh;
  });

  if (!finalised) return fail(res, 404, 'Transfert introuvable.');
  if (finalised === 'incomplet') {
    return fail(res, 409, 'Certains fichiers n\'ont pas ete envoyes entierement.');
  }

  sendJson(res, 200, {
    id: transfer.id,
    url: `${publicBaseUrl(req)}/t/${transfer.id}`,
    expiresAt: transfer.expiresAt,
  });
}

async function deleteTransferRoute(req, res, url, id) {
  const transfer = await store.readTransfer(id);
  if (!transfer) return fail(res, 404, 'Transfert introuvable.');

  // La moderation repond aux signalements d'abus : le contenu reste illisible,
  // seul le retrait est possible. Desactivee tant qu'ADMIN_TOKEN est vide.
  const moderator = Boolean(config.adminToken)
    && timingSafeEquals(req.headers['x-admin-token'], config.adminToken);

  if (!moderator && !isOwner(req, url, transfer)) {
    return fail(res, 403, 'Jeton d\'envoi invalide.');
  }

  await store.deleteTransfer(id);
  stats.transferRemoved(transfer);
  if (moderator) {
    stats.moderationCounted();
    console.log(`[moderation] transfert ${id} supprime (${transfer.files.length} fichier(s), `
      + `cree le ${transfer.createdAt})`);
  }
  sendJson(res, 200, { deleted: true, moderated: moderator });
}

async function getTransferRoute(req, res, url, id) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!transfer.complete && !isOwner(req, url, transfer)) {
    return fail(res, 404, 'Ce transfert n\'est pas encore disponible.');
  }
  if (!isOwner(req, url, transfer) && !hasAccess(req, url, transfer)) {
    return sendJson(res, 401, { error: 'Mot de passe requis.', protected: true });
  }
  sendJson(res, 200, store.publicView(transfer));
}

async function authTransferRoute(req, res, id) {
  const gate = limits.passwordAttempt(req);
  if (!gate.ok) {
    return failRate(res, gate.retryAfter,
      `Trop de tentatives. Reessayez dans ${minutesLabel(gate.retryAfter)}.`);
  }

  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  const body = await readJsonBody(req);
  if (!transfer.password) return sendJson(res, 200, { token: null });
  if (!store.verifyPassword(String(body.password || ''), transfer.password)) {
    return fail(res, 401, 'Mot de passe incorrect.');
  }
  sendJson(res, 200, { token: store.issueAccessToken(transfer.id) });
}

/**
 * Comptabilise un telechargement et indique s'il est autorise.
 *
 * Tout se passe dans le verrou du transfert, relecture comprise : deux
 * telechargements simultanes ne peuvent ni ecraser leur incrementation
 * mutuelle, ni depasser ensemble la limite maxDownloads.
 *
 * Si la limite est atteinte, le transfert sera supprime au prochain acces
 * (loadTransfer), la ou les jauges sont ajustees une seule fois. Le supprimer
 * ici reviendrait a effacer un fichier en cours de lecture.
 */
async function countDownload(id) {
  return store.withTransferLock(id, async () => {
    const fresh = await store.readTransfer(id);
    if (!fresh || store.isExpired(fresh)) return false;
    fresh.downloads += 1;
    fresh.lastDownloadAt = new Date().toISOString();
    await store.writeTransfer(fresh).catch(() => {});
    stats.downloadCounted();
    return true;
  });
}

/**
 * Marque des fichiers comme recuperes et, en mode « destruction apres
 * telechargement », efface le transfert des que tous l'ont ete.
 *
 * Appelee une fois le flux termine : supprimer un fichier en cours de lecture
 * echouerait sous Windows. Une archive chiffree etant fabriquee par le
 * navigateur, elle telecharge les fichiers un a un — d'ou le decompte par
 * fichier plutot que par telechargement.
 */
async function markFetched(id, fileIds) {
  const burned = await store.withTransferLock(id, async () => {
    const fresh = await store.readTransfer(id);
    if (!fresh) return null;

    for (const file of fresh.files) {
      if (fileIds.includes(file.id)) file.fetched = true;
    }

    if (!fresh.burnAfterReading || !fresh.files.every((f) => f.fetched)) {
      await store.writeTransfer(fresh).catch(() => {});
      return null;
    }

    await store.deleteTransfer(id);
    return fresh;
  });

  if (burned) {
    stats.transferRemoved(burned);
    console.log(`[destruction] transfert ${id} efface apres telechargement`);
  }
}

async function downloadFileRoute(req, res, url, id, fileId) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!transfer.complete) return fail(res, 409, 'Transfert incomplet.');
  if (!hasAccess(req, url, transfer)) return fail(res, 401, 'Mot de passe requis.');

  const entry = transfer.files.find((f) => f.id === fileId);
  if (!entry) return fail(res, 404, 'Fichier introuvable.');

  const target = store.filePath(id, fileId);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return fail(res, 404, 'Fichier introuvable sur le serveur.');
  }

  // Reprise de telechargement (Range)
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  let status = 200;

  if (range) {
    const [, s, e] = range;
    if (s === '' && e === '') return fail(res, 416, 'Plage invalide.');
    if (s === '') {
      start = Math.max(0, stat.size - Number(e));
    } else {
      start = Number(s);
      if (e !== '') end = Math.min(end, Number(e));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
  }

  // Comptabilise avant d'envoyer le moindre octet : une fois les en-tetes
  // ecrits, il est trop tard pour refuser la demande.
  if (start === 0 && req.method !== 'HEAD' && !(await countDownload(id))) {
    return fail(res, 410, 'Ce transfert a atteint sa limite de telechargements.');
  }

  const headers = {
    'content-type': entry.type || 'application/octet-stream',
    'content-length': end - start + 1,
    'content-disposition': contentDisposition(entry.name),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;

  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  let complete = true;
  await pipeline(fs.createReadStream(target, { start, end }), res).catch(() => { complete = false; });

  // Le fichier ne compte comme recupere que s'il a ete servi en entier.
  if (complete && start === 0 && end === stat.size - 1) {
    await markFetched(id, [fileId]);
  }
}

async function downloadZipRoute(req, res, url, id) {
  const transfer = await loadTransfer(res, id);
  if (!transfer) return;
  if (!transfer.complete) return fail(res, 409, 'Transfert incomplet.');
  if (!hasAccess(req, url, transfer)) return fail(res, 401, 'Mot de passe requis.');
  if (transfer.encrypted) {
    // Le serveur ne detient pas la cle : l'archive est fabriquee par le navigateur.
    return fail(res, 409, 'Transfert chiffre : l\'archive est generee par le navigateur.');
  }

  const entries = [];
  for (const file of transfer.files) {
    const target = store.filePath(id, file.id);
    try {
      const stat = await fsp.stat(target);
      entries.push({ name: file.name, path: target, size: stat.size, mtime: stat.mtime });
    } catch { /* fichier manquant : ignore */ }
  }
  if (!entries.length) return fail(res, 404, 'Aucun fichier disponible.');

  if (!(await countDownload(id))) {
    return fail(res, 410, 'Ce transfert a atteint sa limite de telechargements.');
  }

  const zipName = `youseal-${transfer.id.slice(0, 8)}.zip`;
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': computeZipSize(entries),
    'content-disposition': contentDisposition(zipName),
    'cache-control': 'no-store',
  });

  let complete = true;
  await pipeline(createZipStream(entries), res).catch(() => { complete = false; });

  if (complete) await markFetched(id, transfer.files.map((f) => f.id));
}

// --- Appairage par code court ------------------------------------------------

async function createPairingRoute(req, res) {
  const gate = limits.hit(`pair:${limits.clientIp(req)}`, 30, 3600_000);
  if (!gate.ok) {
    return failRate(res, gate.retryAfter,
      `Trop de codes demandes. Reessayez dans ${minutesLabel(gate.retryAfter)}.`);
  }

  const body = await readJsonBody(req, 8192);
  if (!store.isValidId(body.transferId)) return fail(res, 400, 'Transfert invalide.');
  if (!pairing.isKeyMaterial(body.senderPublicKey)) return fail(res, 400, 'Cle publique invalide.');

  // Inutile d'ouvrir un rendez-vous vers un transfert qui n'existe pas.
  const transfer = await store.readTransfer(body.transferId);
  if (!transfer || store.isExpired(transfer)) return fail(res, 404, 'Transfert introuvable.');

  const result = pairing.create(body);
  if (result.error) return fail(res, 503, result.error);
  sendJson(res, 201, result);
}

async function claimPairingRoute(req, res, code) {
  // Six caracteres, donc devinables sans plafond sur les essais.
  const gate = limits.hit(`claim:${limits.clientIp(req)}`, 20, 10 * 60_000);
  if (!gate.ok) {
    return failRate(res, gate.retryAfter,
      `Trop d'essais. Reessayez dans ${minutesLabel(gate.retryAfter)}.`);
  }
  if (!pairing.isValidCode(code)) return fail(res, 400, 'Code invalide.');

  const body = await readJsonBody(req, 8192);
  if (!pairing.isKeyMaterial(body.publicKey)) return fail(res, 400, 'Cle publique invalide.');

  const result = pairing.claim(code, body.publicKey);
  if (result.error) return fail(res, 404, result.error);
  sendJson(res, 200, result);
}

function pairingStatusRoute(req, res, url, code) {
  const result = pairing.status(code, url.searchParams.get('token'));
  if (!result) return fail(res, 404, 'Appairage inconnu ou expire.');
  sendJson(res, 200, result);
}

async function deliverPairingRoute(req, res, code) {
  const body = await readJsonBody(req, 8192);
  if (!pairing.isKeyMaterial(body.wrappedKey)) return fail(res, 400, 'Paquet invalide.');
  const result = pairing.deliver(code, body.token, body.wrappedKey);
  if (result.error) return fail(res, 404, result.error);
  sendJson(res, 200, result);
}

function collectPairingRoute(req, res, url, code) {
  const result = pairing.collect(code, url.searchParams.get('token'));
  if (!result) return fail(res, 404, 'Appairage inconnu ou expire.');
  sendJson(res, 200, result);
}

// --- Routeur -----------------------------------------------------------------

const ROUTES = [
  { method: 'POST', re: /^\/api\/pairings$/, handler: (req, res) => createPairingRoute(req, res) },
  { method: 'POST', re: /^\/api\/pairings\/([^/]+)\/claim$/, handler: (req, res, url, m) => claimPairingRoute(req, res, m[1]) },
  { method: 'GET', re: /^\/api\/pairings\/([^/]+)$/, handler: (req, res, url, m) => pairingStatusRoute(req, res, url, m[1]) },
  { method: 'PUT', re: /^\/api\/pairings\/([^/]+)\/key$/, handler: (req, res, url, m) => deliverPairingRoute(req, res, m[1]) },
  { method: 'GET', re: /^\/api\/pairings\/([^/]+)\/key$/, handler: (req, res, url, m) => collectPairingRoute(req, res, url, m[1]) },
  { method: 'POST', re: /^\/api\/transfers$/, handler: (req, res) => createTransferRoute(req, res) },
  { method: 'GET', re: /^\/api\/transfers\/([^/]+)$/, handler: (req, res, url, m) => getTransferRoute(req, res, url, m[1]) },
  { method: 'DELETE', re: /^\/api\/transfers\/([^/]+)$/, handler: (req, res, url, m) => deleteTransferRoute(req, res, url, m[1]) },
  { method: 'POST', re: /^\/api\/transfers\/([^/]+)\/auth$/, handler: (req, res, url, m) => authTransferRoute(req, res, m[1]) },
  { method: 'POST', re: /^\/api\/transfers\/([^/]+)\/complete$/, handler: (req, res, url, m) => completeTransferRoute(req, res, url, m[1]) },
  { method: 'PUT', re: /^\/api\/transfers\/([^/]+)\/files\/([^/]+)$/, handler: (req, res, url, m) => uploadFileRoute(req, res, url, m[1], m[2]) },
  { method: 'GET', re: /^\/api\/transfers\/([^/]+)\/files\/([^/]+)\/status$/, handler: (req, res, url, m) => fileStatusRoute(req, res, url, m[1], m[2]) },
  { method: 'GET', re: /^\/api\/transfers\/([^/]+)\/files\/([^/]+)\/download$/, handler: (req, res, url, m) => downloadFileRoute(req, res, url, m[1], m[2]) },
  { method: 'GET', re: /^\/api\/transfers\/([^/]+)\/download$/, handler: (req, res, url, m) => downloadZipRoute(req, res, url, m[1]) },
];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (pathname === '/api/stats') return sendJson(res, 200, stats.snapshot());

  if (pathname === '/api/stats/stream') {
    if (method !== 'GET') return fail(res, 405, 'Methode non autorisee.');
    return stats.subscribe(req, res);
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, limits: {
      maxFileSize: config.maxFileSize,
      maxTransferSize: config.maxTransferSize,
      maxFiles: config.maxFilesPerTransfer,
      defaultExpiryDays: config.defaultExpiryDays,
      maxExpiryDays: config.maxExpiryDays,
    } });
  }

  let pathMatched = false;
  for (const route of ROUTES) {
    const match = route.re.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== method) continue; // une autre route sert peut-etre cette methode
    return route.handler(req, res, url, match);
  }
  if (pathMatched) return fail(res, 405, 'Methode non autorisee.');

  if (method !== 'GET') return fail(res, 405, 'Methode non autorisee.');

  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
  if (/^\/t\/[a-f0-9]+\/?$/.test(pathname)) return serveStatic(res, 'transfer.html');
  if (/^\/(conditions|contact|statistiques|soutien|transparence)\/?$/.test(pathname)) {
    return serveStatic(res, `${pathname.replace(/\//g, '')}.html`);
  }
  if (/^\/(app|transfer|common|fdcrypto|zipstream|sw|stats|history|soutien|qr|pair|uptime)\.js$|^\/style\.css$|^\/favicon\.svg$|^\/og\.png$/.test(pathname)) {
    return serveStatic(res, pathname.slice(1));
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 - Introuvable');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    const status = err.status || 500;
    if (status >= 500) console.error(`[erreur] ${req.method} ${req.url}`, err);
    fail(res, status, status >= 500 ? 'Erreur interne du serveur.' : err.message);
  });
});

server.requestTimeout = 0; // gros uploads
server.headersTimeout = 60_000;

(async () => {
  await store.init();

  const removed = await store.cleanup();
  if (removed) console.log(`[nettoyage] ${removed} transfert(s) expire(s) supprime(s)`);

  await stats.init(store);
  limits.start();
  pairing.start();

  setInterval(() => {
    store.cleanup()
      .then((n) => {
        if (n) console.log(`[nettoyage] ${n} transfert(s) expire(s) supprime(s)`);
        return stats.recomputeLive(store);
      })
      .then(() => prune.pruneIfNeeded(store, stats))
      .then(() => stats.recomputeLive(store))
      .catch((err) => console.error('[nettoyage]', err));
  }, config.cleanupIntervalMs).unref();

  server.listen(config.port, config.host, () => {
    console.log(`YouSeal demarre sur http://localhost:${config.port}`);
    console.log(`Stockage : ${config.storageDir}`);
  });
})();
