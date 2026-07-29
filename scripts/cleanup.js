'use strict';

/* Purge manuelle des transferts expires : node scripts/cleanup.js */

const store = require('../lib/store');

(async () => {
  await store.init();
  const removed = await store.cleanup();
  console.log(`${removed} transfert(s) supprime(s).`);
})();
