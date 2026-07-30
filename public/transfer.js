'use strict';

/*
 * Page de reception.
 *
 * La cle vient du fragment de l'URL (#...), qui n'est jamais transmis au
 * serveur. Elle sert a dechiffrer le manifeste (noms, message) puis les
 * fichiers eux-memes. Le dechiffrement se fait en flux dans un Service Worker
 * pour ne pas charger un fichier entier en memoire ; a defaut, on retombe sur
 * un dechiffrement en memoire.
 */

const transferId = location.pathname.replace(/^\/t\//, '').replace(/\/$/, '');
const keyText = location.hash.slice(1);

const view = {
  loading: $('#state-loading'),
  password: $('#state-password'),
  error: $('#state-error'),
  content: $('#state-content'),
};

let accessToken = null;
let cryptoKey = null;
let entries = [];        // { fileId, name, size, stored, compressed, type }
let transferChunk;       // découpage choisi par l'expéditeur, lu dans le manifeste
let workerReady = null;

function show(name) {
  for (const [key, node] of Object.entries(view)) node.hidden = key !== name;
}

function fail(title, text) {
  $('#error-title').textContent = title;
  $('#error-text').textContent = text;
  show('error');
}

// --- Chargement --------------------------------------------------------------

async function load() {
  let res;
  try {
    res = await fetch(`/api/transfers/${encodeURIComponent(transferId)}`, {
      headers: accessToken ? { 'x-access-token': accessToken } : {},
    });
  } catch {
    return fail('Connexion impossible', 'Le serveur ne répond pas. Réessayez dans un instant.');
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) return show('password');
  if (res.status === 410) {
    return fail('Transfert expiré',
      'Ce lien n\'est plus valide : le transfert a expiré ou atteint sa limite de téléchargements.');
  }
  if (!res.ok) {
    return fail('Transfert introuvable', data.error || 'Ce lien ne correspond à aucun transfert.');
  }

  if (data.encrypted) {
    if (!keyText) {
      return fail('Lien incomplet',
        'La clé de déchiffrement manque dans l\'adresse. Le lien a probablement été tronqué : '
        + 'demandez à l\'expéditeur de vous renvoyer le lien complet, avec la partie après le #.');
    }
    try {
      cryptoKey = await fdImportKey(keyText);
      const manifest = await fdDecryptManifest(cryptoKey, data.manifest);
      transferChunk = manifest.chunk;
      entries = data.files.map((file, i) => {
        const decrit = manifest.files[i] || {};
        return {
          fileId: file.id,
          name: decrit.name || `fichier-${i + 1}`,
          size: decrit.size ?? 0,
          // `stored` n'existe que depuis la compression : sans lui, ce qui a été
          // chiffré est le fichier lui-même.
          stored: decrit.stored ?? decrit.size ?? 0,
          compressed: Boolean(decrit.compressed),
          type: decrit.type || 'application/octet-stream',
        };
      });
      data.message = manifest.message || '';
      data.totalSize = entries.reduce((sum, e) => sum + e.size, 0);
    } catch {
      return fail('Déchiffrement impossible',
        'La clé contenue dans le lien ne correspond pas à ce transfert, ou les données ont été altérées.');
    }
  } else {
    entries = data.files.map((file) => ({
      fileId: file.id, name: file.name, size: file.size,
      stored: file.size, compressed: false, type: file.type,
    }));
  }

  render(data);
}

function render(data) {
  const count = entries.length;
  $('#title').textContent = count > 1 ? `${count} fichiers partagés` : 'Fichier partagé';
  $('#subtitle').textContent =
    `${formatBytes(data.totalSize)} · envoyé le ${formatDate(data.createdAt)}`;

  if (data.message) {
    $('#message').textContent = data.message;
    $('#message').hidden = false;
  }

  const list = $('#files');
  list.innerHTML = '';
  entries.forEach((entry, index) => {
    const row = document.createElement(data.encrypted ? 'button' : 'a');
    row.className = 'dl-file';
    row.type = 'button';
    if (!data.encrypted) {
      row.href = accessToken
        ? `/api/transfers/${data.id}/files/${entry.fileId}/download?k=${encodeURIComponent(accessToken)}`
        : `/api/transfers/${data.id}/files/${entry.fileId}/download`;
    }
    row.innerHTML = `
      <div class="meta">
        <div class="name"></div>
        <div class="size">${formatBytes(entry.size)}</div>
      </div>
      <span class="link-btn">Télécharger</span>`;
    row.querySelector('.name').textContent = entry.name;
    if (data.encrypted) {
      row.addEventListener('click', () => download([entry], 'single'));
    }
    list.appendChild(row);
  });

  const all = $('#download-all');
  all.hidden = count < 2;
  all.onclick = () => {
    if (data.encrypted) return download(entries, 'zip');
    const base = `/api/transfers/${data.id}/download`;
    location.href = accessToken ? `${base}?k=${encodeURIComponent(accessToken)}` : base;
  };

  $('#burn-notice').hidden = !data.burnAfterReading;

  if (cryptoKey) {
    fdFingerprint(cryptoKey).then((empreinte) => {
      const block = $('#fingerprint');
      block.querySelector('b').textContent = empreinte;
      block.hidden = false;
    }).catch(() => {});
  }

  $('#meta-expiry').textContent =
    `Expire le ${formatDate(data.expiresAt)} (${remainingLabel(data.expiresAt)})`;
  $('#meta-downloads').textContent = data.burnAfterReading
    ? 'Détruit après téléchargement'
    : data.maxDownloads
      ? `${data.downloads} / ${data.maxDownloads} téléchargements`
      : `${data.downloads} téléchargement${data.downloads > 1 ? 's' : ''}`;
  $('#privacy').hidden = !data.encrypted;

  show('content');
}

// --- Telechargement ----------------------------------------------------------

/** Enregistre le Service Worker et attend qu'il controle la page. */
function ensureWorker() {
  if (workerReady) return workerReady;
  workerReady = (async () => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
    try {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) return true;
      // Premiere visite : le worker prend le controle juste apres son activation.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return Boolean(navigator.serviceWorker.controller);
    } catch {
      return false;
    }
  })();
  return workerReady;
}

function zipName() {
  return `youseal-${transferId.slice(0, 8)}.zip`;
}

async function download(selection, mode) {
  const filename = mode === 'zip' ? zipName() : selection[0].name;

  if (await ensureWorker()) {
    const id = crypto.randomUUID();
    navigator.serviceWorker.controller.postMessage({
      type: 'job',
      id,
      job: {
        transferId,
        accessToken,
        key: cryptoKey,
        mode,
        filename,
        chunk: transferChunk,
        entries: selection.map((e) => ({
          fileId: e.fileId, name: e.name, size: e.size,
          stored: e.stored, compressed: e.compressed,
        })),
      },
    });
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = `/dl/${id}`;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);
    return;
  }

  // Repli : dechiffrement en memoire (pas de Service Worker disponible).
  const total = selection.reduce((sum, e) => sum + e.size, 0);
  if (total > 1024 ** 3 && !confirm(
    `Le déchiffrement en flux n'est pas disponible sur cette page (HTTPS requis).\n`
    + `${formatBytes(total)} vont être déchiffrés en mémoire, ce qui peut faire échouer l'opération.\n\n`
    + `Continuer ?`)) return;

  toast('Déchiffrement en cours…');
  try {
    const stream = mode === 'zip'
      ? fdCreateZipStream(
        selection.map((e) => ({ name: e.name, size: e.size })),
        (entry, index) => plainStream(selection[index])
      )
      : await plainStream(selection[0]);

    const blob = await new Response(stream).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    toast(`Échec du déchiffrement : ${err.message}`);
  }
}

async function plainStream(entry) {
  const base = `/api/transfers/${transferId}/files/${entry.fileId}/download`;
  const res = await fetch(accessToken ? `${base}?k=${encodeURIComponent(accessToken)}` : base);
  if (!res.ok) throw new Error(`téléchargement impossible (${res.status})`);

  // Ce qui a été chiffré, c'est `stored` : le fichier, ou sa version compressée.
  const clair = fdStreamFrom(
    fdDecryptStream(cryptoKey, entry.fileId, entry.stored, res.body, transferChunk));
  return entry.compressed ? fdDecompressStream(clair) : clair;
}

// --- Deverrouillage ----------------------------------------------------------

async function unlock() {
  const input = $('#password');
  const errorNode = $('#password-error');
  const button = $('#unlock');

  errorNode.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch(`/api/transfers/${encodeURIComponent(transferId)}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorNode.textContent = data.error || 'Mot de passe incorrect.';
      errorNode.hidden = false;
      input.select();
      return;
    }
    accessToken = data.token;
    show('loading');
    await load();
  } catch {
    errorNode.textContent = 'Connexion impossible.';
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
}

$('#unlock').addEventListener('click', unlock);
$('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

if (!/^[a-f0-9]{20,64}$/.test(transferId)) {
  fail('Lien invalide', 'Cette adresse ne correspond à aucun transfert.');
} else {
  load();
}
