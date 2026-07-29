'use strict';

/**
 * Garde-fous d'usage : limitation par adresse et quota de stockage.
 *
 * Compteurs en memoire, par fenetre glissante fixe. Suffisant pour un serveur
 * unique ; derriere plusieurs instances il faudrait un stockage partage.
 */

const config = require('./config');

const buckets = new Map(); // cle -> { count, resetAt }

/** Adresse du client, en tenant compte du proxy uniquement si on lui fait confiance. */
function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'inconnu';
}

/**
 * Enregistre une tentative et indique si elle est autorisee.
 * @returns {{ok: boolean, retryAfter: number, remaining: number}}
 */
function hit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    ok: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    remaining: Math.max(0, limit - bucket.count),
  };
}

/** Nombre d'occurrences en cours pour une cle, sans l'incrementer. */
function count(key) {
  const bucket = buckets.get(key);
  return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
}

function createTransfer(req) {
  return hit(`create:${clientIp(req)}`, config.rateCreatePerHour, 3600_000);
}

function passwordAttempt(req) {
  return hit(`auth:${clientIp(req)}`, config.rateAuthPer15Min, 15 * 60_000);
}

/** Retire les fenetres expirees pour que la table ne grossisse pas indefiniment. */
function sweep() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function start() {
  const timer = setInterval(sweep, 10 * 60_000);
  timer.unref();
}

module.exports = { clientIp, hit, count, createTransfer, passwordAttempt, sweep, start };
