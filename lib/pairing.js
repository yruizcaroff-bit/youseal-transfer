'use strict';

/**
 * Appairage par code court.
 *
 * Permet d'ouvrir un transfert sur un second appareil en tapant six caracteres,
 * plutot qu'en recopiant un lien de quatre-vingt-dix.
 *
 * Le code ne transporte pas la cle : il n'identifie qu'un rendez-vous. Les deux
 * navigateurs y deposent chacun une cle publique ephemere, en derivent un secret
 * commun par ECDH, et l'expediteur s'en sert pour emballer la cle du transfert.
 * Le serveur ne voit que deux cles publiques et un paquet qu'il ne peut pas
 * ouvrir, faute de detenir la moindre cle privee.
 *
 * Tout est garde en memoire et expire en dix minutes : un rendez-vous manque ne
 * laisse aucune trace sur le disque.
 */

const crypto = require('crypto');

// Alphabet sans 0, O, 1 ni I : le code se dicte a l'oral.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const TTL_MS = 10 * 60 * 1000;
const MAX_PAIRINGS = 5000;
const MAX_KEY_LENGTH = 512;

const pairings = new Map();

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!pairings.has(code)) return code;
  }
  return null;
}

function normalise(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function isValidCode(code) {
  const clean = normalise(code);
  return clean.length === CODE_LENGTH && [...clean].every((c) => ALPHABET.includes(c));
}

function isKeyMaterial(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function sweep() {
  const now = Date.now();
  for (const [code, item] of pairings) {
    if (item.expiresAt <= now) pairings.delete(code);
  }
}

function get(code) {
  const item = pairings.get(normalise(code));
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    pairings.delete(normalise(code));
    return null;
  }
  return item;
}

/** L'expediteur ouvre un rendez-vous et obtient le code a dicter. */
function create({ transferId, senderPublicKey }) {
  sweep();
  if (pairings.size >= MAX_PAIRINGS) return { error: 'Trop d\'appairages en cours.' };

  const code = newCode();
  if (!code) return { error: 'Impossible d\'allouer un code.' };

  const item = {
    transferId,
    senderPublicKey,
    senderToken: crypto.randomBytes(16).toString('base64url'),
    receiverToken: null,
    receiverPublicKey: null,
    wrappedKey: null,
    expiresAt: Date.now() + TTL_MS,
  };
  pairings.set(code, item);
  return { code, token: item.senderToken, expiresAt: item.expiresAt };
}

/** Le second appareil se presente. Un code ne peut etre reclame qu'une fois. */
function claim(code, receiverPublicKey) {
  const item = get(code);
  if (!item) return { error: 'Code inconnu ou expire.' };
  if (item.receiverPublicKey) return { error: 'Ce code a deja ete utilise.' };

  item.receiverPublicKey = receiverPublicKey;
  item.receiverToken = crypto.randomBytes(16).toString('base64url');
  return {
    token: item.receiverToken,
    transferId: item.transferId,
    senderPublicKey: item.senderPublicKey,
  };
}

function equals(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

/** L'expediteur guette l'arrivee du second appareil. */
function status(code, token) {
  const item = get(code);
  if (!item || !equals(token, item.senderToken)) return null;
  return { claimed: Boolean(item.receiverPublicKey), receiverPublicKey: item.receiverPublicKey };
}

/** L'expediteur depose la cle emballee. */
function deliver(code, token, wrappedKey) {
  const item = get(code);
  if (!item || !equals(token, item.senderToken)) return { error: 'Appairage inconnu.' };
  if (!item.receiverPublicKey) return { error: 'Aucun appareil ne s\'est presente.' };
  item.wrappedKey = wrappedKey;
  return { delivered: true };
}

/** Le second appareil recupere la cle emballee, puis le rendez-vous disparait. */
function collect(code, token) {
  const item = get(code);
  if (!item || !equals(token, item.receiverToken)) return null;
  if (!item.wrappedKey) return { pending: true };

  pairings.delete(normalise(code));
  return {
    wrappedKey: item.wrappedKey,
    senderPublicKey: item.senderPublicKey,
    transferId: item.transferId,
  };
}

function start() {
  const timer = setInterval(sweep, 60_000);
  timer.unref();
}

module.exports = {
  create, claim, status, deliver, collect,
  isValidCode, isKeyMaterial, normalise, sweep, start,
  CODE_LENGTH, TTL_MS,
};
