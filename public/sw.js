'use strict';

/**
 * Service Worker de telechargement.
 *
 * La page ne peut pas ecrire directement un flux dechiffre sur le disque : sans
 * ce worker, il faudrait garder tout le fichier en memoire. Ici, la page
 * enregistre une « tache » puis ouvre /dl/<id> ; le worker intercepte la
 * requete, recupere le chiffre depuis l'API, le dechiffre bloc par bloc et
 * repond en flux avec Content-Disposition — le navigateur ecrit directement
 * dans le fichier de destination.
 */

// Le numero de version doit suivre celui des pages : sans lui, ces scripts
// arrivent depuis le cache du reseau de diffusion et peuvent etre en retard
// d'une version sur le worker qui les importe.
importScripts('/fdcrypto.js?v=10', '/zipstream.js?v=10');

const jobs = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'job') {
    jobs.set(data.id, data.job);
    // Filet de securite : une tache jamais reclamee ne reste pas en memoire.
    setTimeout(() => jobs.delete(data.id), 5 * 60 * 1000);
  }
  if (data.type === 'ping' && event.ports[0]) event.ports[0].postMessage({ ready: true });
});

function attachment(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function cipherUrl(job, fileId) {
  const base = `/api/transfers/${job.transferId}/files/${fileId}/download`;
  return job.accessToken ? `${base}?k=${encodeURIComponent(job.accessToken)}` : base;
}

/** Flux en clair pour une entree du transfert. */
async function plainStream(job, entry) {
  const res = await fetch(cipherUrl(job, entry.fileId));
  if (!res.ok) throw new Error(`Telechargement impossible (${res.status}).`);

  // `stored` est ce qui a ete chiffre ; `size` est la taille rendue au visiteur,
  // apres decompression eventuelle.
  const stored = entry.stored ?? entry.size;
  const clair = fdStreamFrom(
    fdDecryptStream(job.key, entry.fileId, stored, res.body, job.chunk));
  return entry.compressed ? fdDecompressStream(clair) : clair;
}

async function respond(job) {
  if (job.mode === 'zip') {
    const entries = job.entries.map((e) => ({ name: e.name, size: e.size }));
    return new Response(
      fdCreateZipStream(entries, (entry, index) => plainStream(job, job.entries[index])),
      {
        headers: {
          'content-type': 'application/zip',
          'content-length': String(fdZipSize(entries)),
          'content-disposition': attachment(job.filename),
          'cache-control': 'no-store',
        },
      }
    );
  }

  const entry = job.entries[0];
  return new Response(await plainStream(job, entry), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(entry.size),
      'content-disposition': attachment(entry.name),
      'cache-control': 'no-store',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/dl/')) return;

  const job = jobs.get(url.pathname.slice(4));
  if (!job) return; // tache inconnue : le serveur repondra 404

  jobs.delete(url.pathname.slice(4));
  event.respondWith(
    respond(job).catch((err) => new Response(`Erreur de dechiffrement : ${err.message}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }))
  );
});
