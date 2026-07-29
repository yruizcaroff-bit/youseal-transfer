'use strict';

/**
 * Compteurs d'utilisation.
 *
 * Uniquement des totaux agreges : aucun identifiant de transfert, aucune adresse
 * IP, aucun nom de fichier. Le chiffrement de bout en bout rend d'ailleurs ces
 * derniers illisibles pour le serveur.
 *
 * Les totaux cumules sont persistes dans storage/stats.json ; les jauges
 * « en ce moment » sont recalculees au demarrage et apres chaque purge.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const limits = require('./limits');

const FLUSH_DELAY = 2000;   // ecriture disque au plus toutes les 2 s
const BROADCAST_DELAY = 400; // regroupe les rafales d'evenements
const HEARTBEAT = 25000;     // garde la connexion SSE ouverte a travers les proxys

const totals = {
  since: new Date().toISOString(),
  transfers: 0,
  files: 0,
  bytes: 0,
  downloads: 0,
  // Transferts retires a la suite d'un signalement : publie sur la page de
  // transparence, ou l'absence de chiffre serait aussi parlante que sa valeur.
  moderated: 0,
};

// activeXxx : transferts finalises et encore valides (ce que voient les visiteurs).
// reservedBytes : place engagee sur le disque, y compris les envois en cours,
// car le quota doit etre verifie avant que les octets n'arrivent.
const live = { activeTransfers: 0, activeFiles: 0, activeBytes: 0, reservedBytes: 0 };

// Debut de ce processus : distinct de `since`, qui date le tout premier
// demarrage et survit aux redemarrages.
const startedAt = new Date().toISOString();

const clients = new Set();
let dirty = false;
let flushTimer = null;
let broadcastTimer = null;

function statsFile() {
  return path.join(config.storageDir, 'stats.json');
}

async function load() {
  try {
    Object.assign(totals, JSON.parse(await fsp.readFile(statsFile(), 'utf8')));
  } catch {
    await flush(); // premier demarrage
  }
}

async function flush() {
  dirty = false;
  const target = statsFile();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(totals, null, 2));
    await fsp.rename(tmp, target);
  } catch { /* le compteur ne doit jamais faire tomber le service */ }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) flush();
  }, FLUSH_DELAY);
  flushTimer.unref();
}

/** Parcourt le stockage pour recalculer les jauges « en ce moment ». */
async function recomputeLive(store) {
  let transfers = 0;
  let files = 0;
  let bytes = 0;
  let reserved = 0;
  try {
    const entries = await fsp.readdir(config.storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !store.isValidId(entry.name)) continue;
      const transfer = await store.readTransfer(entry.name);
      if (!transfer) continue;
      reserved += transfer.totalSize; // envois en cours compris
      if (!transfer.complete || store.isExpired(transfer)) continue;
      transfers += 1;
      files += transfer.files.length;
      bytes += transfer.totalSize;
    }
  } catch { /* stockage illisible : on garde les valeurs precedentes */ }

  live.activeTransfers = transfers;
  live.activeFiles = files;
  live.activeBytes = bytes;
  live.reservedBytes = reserved;
  broadcast();
}

/** Place deja engagee sur le disque, pour le controle de quota. */
function reservedBytes() {
  return live.reservedBytes;
}

/**
 * Retire les abonnes dont la socket est morte. Un navigateur qui quitte la page
 * ne provoque pas toujours d'evenement exploitable cote Node : on verifie donc
 * l'etat reel du flux avant toute lecture ou tout envoi.
 */
function prune() {
  for (const res of clients) {
    if (res.destroyed || res.writableEnded) clients.delete(res);
  }
}

function snapshot() {
  prune();
  return {
    ...totals,
    ...live,
    watching: clients.size,
    startedAt,
    now: new Date().toISOString(),
  };
}

// --- Evenements --------------------------------------------------------------

/** Un transfert vient d'etre cree : la place est engagee des maintenant. */
function transferCreated(transfer) {
  live.reservedBytes += transfer.totalSize;
  broadcast();
}

/** Un transfert vient d'etre finalise. */
function transferCompleted(transfer) {
  totals.transfers += 1;
  totals.files += transfer.files.length;
  totals.bytes += transfer.totalSize;
  live.activeTransfers += 1;
  live.activeFiles += transfer.files.length;
  live.activeBytes += transfer.totalSize;
  scheduleFlush();
  broadcast();
}

/** Un transfert a ete retire a la suite d'un signalement. */
function moderationCounted() {
  totals.moderated += 1;
  scheduleFlush();
  broadcast();
}

/** Un fichier ou une archive vient d'etre telecharge. */
function downloadCounted() {
  totals.downloads += 1;
  scheduleFlush();
  broadcast();
}

/** Un transfert disparait (suppression manuelle, abandon ou expiration). */
function transferRemoved(transfer) {
  if (!transfer) return;
  live.reservedBytes = Math.max(0, live.reservedBytes - transfer.totalSize);
  if (transfer.complete) {
    live.activeTransfers = Math.max(0, live.activeTransfers - 1);
    live.activeFiles = Math.max(0, live.activeFiles - transfer.files.length);
    live.activeBytes = Math.max(0, live.activeBytes - transfer.totalSize);
  }
  broadcast();
}

// --- Diffusion temps reel (SSE) ---------------------------------------------

function broadcast() {
  if (broadcastTimer || !clients.size) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      // Une socket morte ne fait pas echouer write() : on la depiste explicitement.
      if (res.destroyed || res.writableEnded) { clients.delete(res); continue; }
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }, BROADCAST_DELAY);
  broadcastTimer.unref();
}

/** Abonne une reponse HTTP au flux d'evenements. */
function subscribe(req, res) {
  prune();

  // Un flux SSE immobilise une connexion : on plafonne le total et le nombre
  // par adresse pour qu'un seul client ne puisse pas saturer le serveur.
  const ip = limits.clientIp(req);
  const sameIp = [...clients].filter((client) => client.fdIp === ip).length;
  if (clients.size >= config.maxStreamClients || sameIp >= config.maxStreamPerIp) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' });
    return res.end('Trop de connexions simultanees au flux de statistiques.');
  }
  res.fdIp = ip;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // desactive la mise en tampon d'un proxy nginx
  });
  // Sans cela, Node ferme la socket au bout de quelques secondes d'inactivite
  // et le navigateur se reconnecte en boucle.
  if (res.socket) {
    res.socket.setTimeout(0);
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true);
  }

  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  broadcast(); // le compteur de visiteurs change pour tout le monde

  const beat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return close();
    try { res.write(': ping\n\n'); } catch { close(); }
  }, HEARTBEAT);
  beat.unref();

  const close = () => {
    clearInterval(beat);
    if (clients.delete(res)) broadcast();
  };
  // 'close' cote reponse est le signal fiable d'une deconnexion ; celui de la
  // requete ne se declenche pas toujours pour un GET sans corps.
  res.on('close', close);
  res.on('error', close);
  req.on('close', close);
  req.on('error', close);
}

async function init(store) {
  await load();
  await recomputeLive(store);
  const stop = () => { if (dirty) flush(); };
  process.on('beforeExit', stop);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}

module.exports = {
  init,
  snapshot,
  subscribe,
  recomputeLive,
  reservedBytes,
  transferCreated,
  transferCompleted,
  transferRemoved,
  downloadCounted,
  moderationCounted,
};
