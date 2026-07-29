'use strict';

/**
 * Purge d'urgence du stockage.
 *
 * Passe un seuil, les transferts les plus anciens sont effaces jusqu'a liberer
 * la quantite demandee — meme s'ils n'ont pas expire, meme si leur destinataire
 * ne les a jamais recuperes.
 *
 * C'est un arbitrage assume : sans elle, le service atteint sa capacite et
 * refuse tout nouvel envoi jusqu'a ce que les transferts expirent d'eux-memes.
 * Avec elle, quelques liens anciens cessent de fonctionner sans preavis. Les
 * conditions d'utilisation doivent le mentionner, faute de quoi la promesse de
 * conservation jusqu'a l'echeance serait mensongere.
 *
 * L'anciennete se compte a la date de depot. Un classement par derniere
 * consultation epargnerait les transferts encore actifs, mais surprendrait
 * davantage : un lien recent pourrait disparaitre avant un vieux.
 */

const fsp = require('fs/promises');
const config = require('./config');

let running = false;

/** Transferts existants, du plus ancien au plus recent. */
async function listOldestFirst(store) {
  const entries = await fsp.readdir(config.storageDir, { withFileTypes: true });
  const transfers = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !store.isValidId(entry.name)) continue;
    const transfer = await store.readTransfer(entry.name);
    if (transfer) transfers.push(transfer);
  }

  return transfers.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Efface les plus anciens transferts si le seuil est franchi.
 * @returns {Promise<{removed: number, freed: number}>}
 */
async function pruneIfNeeded(store, stats) {
  if (!config.pruneThreshold || !config.pruneAmount) return { removed: 0, freed: 0 };
  if (running) return { removed: 0, freed: 0 };
  if (stats.reservedBytes() < config.pruneThreshold) return { removed: 0, freed: 0 };

  running = true;
  let removed = 0;
  let freed = 0;

  try {
    const transfers = await listOldestFirst(store);
    for (const transfer of transfers) {
      if (freed >= config.pruneAmount) break;
      try {
        await store.deleteTransfer(transfer.id);
      } catch {
        // Un fichier en cours de lecture ne peut pas etre supprime sous
        // Windows : on passe au suivant, il partira au prochain passage.
        continue;
      }
      stats.transferRemoved(transfer);
      freed += transfer.totalSize;
      removed += 1;
    }

    if (removed) {
      console.warn(`[purge] stockage sature : ${removed} transfert(s) parmi les plus anciens `
        + `effaces, ${(freed / 1024 ** 3).toFixed(1)} Go liberes`);
    }
  } catch (err) {
    console.error('[purge]', err);
  } finally {
    running = false;
  }

  return { removed, freed };
}

module.exports = { pruneIfNeeded, listOldestFirst };
