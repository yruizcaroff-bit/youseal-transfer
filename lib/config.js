'use strict';

const path = require('path');

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const GB = 1024 * 1024 * 1024;

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 3000),

  // Repertoire de stockage des transferts (un sous-dossier par transfert).
  storageDir: process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.join(__dirname, '..', 'storage'),

  // Limites
  maxFileSize: int(process.env.MAX_FILE_SIZE, 5 * GB),
  maxTransferSize: int(process.env.MAX_TRANSFER_SIZE, 10 * GB),
  maxFilesPerTransfer: int(process.env.MAX_FILES, 200),
  maxMessageLength: 2000,
  // Manifeste chiffre (noms + message), base64 : ~64 Ko suffisent largement.
  maxManifestLength: 64 * 1024,

  // Duree de vie
  defaultExpiryDays: int(process.env.DEFAULT_EXPIRY_DAYS, 7),
  maxExpiryDays: int(process.env.MAX_EXPIRY_DAYS, 30),

  // Garde-fous : sans eux, n'importe qui peut saturer le disque ou marteler
  // les mots de passe. Capacite totale reservee a l'ensemble des transferts.
  maxStorage: int(process.env.MAX_STORAGE, 50 * GB),
  rateCreatePerHour: int(process.env.RATE_CREATE_PER_HOUR, 20),
  rateAuthPer15Min: int(process.env.RATE_AUTH_PER_15MIN, 20),
  maxStreamClients: int(process.env.MAX_STREAM_CLIENTS, 200),
  maxStreamPerIp: int(process.env.MAX_STREAM_PER_IP, 4),

  // A activer uniquement derriere un reverse proxy de confiance : sinon
  // n'importe quel client peut usurper son adresse via X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === '1',

  // Jeton de moderation : permet de supprimer un transfert signale sans
  // detenir le jeton de l'expediteur. Vide = moderation desactivee.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Nettoyage automatique des transferts expires
  cleanupIntervalMs: int(process.env.CLEANUP_INTERVAL_MS, 60 * 60 * 1000),

  // Duree de validite d'un jeton d'acces (transfert protege par mot de passe)
  accessTokenTtlMs: int(process.env.ACCESS_TOKEN_TTL_MS, 6 * 60 * 60 * 1000),

  // URL publique utilisee pour construire les liens de partage.
  // Laisser vide pour deduire depuis l'en-tete Host de la requete.
  publicUrl: process.env.PUBLIC_URL || '',
};

module.exports = config;
