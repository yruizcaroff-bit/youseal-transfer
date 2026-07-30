'use strict';

/*
 * Page d'envoi.
 *
 * Tout est chiffre ici, dans le navigateur : le contenu des fichiers bloc par
 * bloc, ainsi qu'un manifeste contenant les noms et le message. Le serveur ne
 * recoit que des octets illisibles. La cle part uniquement dans le fragment de
 * l'URL partagee (#...), jamais dans une requete.
 */

const MAX_RETRIES = 3;

const ui = {
  dropzone: $('#dropzone'),
  input: $('#file-input'),
  dirInput: $('#dir-input'),
  filelist: $('#filelist'),
  totals: $('#totals'),
  totalsText: $('#totals-text'),
  clearAll: $('#clear-all'),
  message: $('#message'),
  expiry: $('#expiry'),
  maxDownloads: $('#max-downloads'),
  password: $('#password'),
  send: $('#send'),
  formError: $('#form-error'),

  panelForm: $('#panel-form'),
  panelUpload: $('#panel-upload'),
  panelDone: $('#panel-done'),

  fill: $('#progress-fill'),
  pct: $('#progress-pct'),
  detail: $('#progress-detail'),
  current: $('#upload-current'),
  uploadError: $('#upload-error'),
  cancel: $('#cancel'),
  burn: $('#burn'),
  compress: $('#compress'),

  shareLink: $('#share-link'),
  copy: $('#copy'),
  openLink: $('#open-link'),
  newTransfer: $('#new-transfer'),
  deleteTransfer: $('#delete-transfer'),
  doneSub: $('#done-sub'),
};

let queue = [];          // { key, file, serverId, uploaded (octets en clair), done }
let limits = null;
let transfer = null;     // { id, ownerToken, url }
let transferKey = null;  // CryptoKey AES-256-GCM
let transferChunk = FD_CHUNK; // taille de bloc retenue pour ce transfert
let activeAbort = null;
let uploading = false;
let cancelled = false;
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('Envoi annulé.'), { aborted: true });

// --- Selection des fichiers --------------------------------------------------

/**
 * Ajoute des fichiers à la file.
 *
 * `path` est le chemin relatif au dossier déposé — « photos/été/plage.jpg ».
 * Il sert de nom dans le manifeste, ce qui permet à l'archive de reconstituer
 * l'arborescence chez le destinataire.
 */
function addFiles(items) {
  for (const entree of items) {
    const file = entree.file || entree;
    const path = entree.path || file.webkitRelativePath || file.name;
    const duplicate = queue.some((item) => item.path === path && item.file.size === file.size);
    if (duplicate) continue;
    queue.push({ key: `f${++seq}`, file, path, serverId: null, uploaded: 0, done: false });
  }
  renderQueue();
}

/**
 * Parcourt ce qui a été déposé et en extrait les fichiers, dossiers compris.
 *
 * `readEntries` ne rend les enfants que par paquets : il faut le rappeler
 * jusqu'à ce qu'il ne renvoie plus rien, sinon un dossier de plus d'une
 * centaine d'éléments se retrouve tronqué sans le moindre message.
 */
async function collectDropped(dataTransfer) {
  const racines = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  // Navigateur sans accès à l'arborescence : on se rabat sur les fichiers seuls.
  if (!racines.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));

  const trouves = [];

  const lireDossier = async (reader) => {
    const lot = [];
    for (;;) {
      const paquet = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!paquet.length) return lot;
      lot.push(...paquet);
    }
  };

  const descendre = async (entry, prefixe) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      trouves.push({ file, path: prefixe + entry.name });
      return;
    }
    if (entry.isDirectory) {
      const enfants = await lireDossier(entry.createReader());
      for (const enfant of enfants) {
        await descendre(enfant, `${prefixe + entry.name}/`);
      }
    }
  };

  for (const racine of racines) {
    try { await descendre(racine, ''); } catch { /* dossier illisible : ignoré */ }
  }
  return trouves;
}

function removeFile(key) {
  queue = queue.filter((item) => item.key !== key);
  renderQueue();
}

function totalSize() {
  return queue.reduce((sum, item) => sum + item.file.size, 0);
}

function renderQueue() {
  ui.filelist.innerHTML = '';
  for (const item of queue) {
    const row = document.createElement('div');
    row.className = 'file';
    row.dataset.key = item.key;
    row.innerHTML = `
      <div class="meta">
        <div class="name"></div>
        <div class="size">${formatBytes(item.file.size)}</div>
      </div>
      <button class="icon-btn" type="button" title="Retirer" aria-label="Retirer">&times;</button>
      <div class="bar"><i></i></div>`;
    row.querySelector('.name').textContent = item.path;
    row.querySelector('.icon-btn').addEventListener('click', () => removeFile(item.key));
    ui.filelist.appendChild(row);
  }

  const has = queue.length > 0;
  ui.filelist.hidden = !has;
  ui.totals.hidden = !has;
  ui.send.disabled = !has;
  ui.totalsText.textContent =
    `${queue.length} fichier${queue.length > 1 ? 's' : ''} · ${formatBytes(totalSize())}`;

  checkLimits();
}

function checkLimits() {
  if (!limits || !queue.length) return hideError(ui.formError);
  const total = totalSize();
  const tooBig = queue.find((item) => fdEncryptedSize(item.file.size) > limits.maxFileSize);
  if (tooBig) {
    return showError(ui.formError,
      `« ${tooBig.path} » dépasse la limite de ${formatBytes(limits.maxFileSize)} par fichier.`);
  }
  if (queue.reduce((s, i) => s + fdEncryptedSize(i.file.size), 0) > limits.maxTransferSize) {
    return showError(ui.formError,
      `Le total (${formatBytes(total)}) dépasse la limite de ${formatBytes(limits.maxTransferSize)}.`);
  }
  if (queue.length > limits.maxFiles) {
    return showError(ui.formError, `Maximum ${limits.maxFiles} fichiers par transfert.`);
  }
  hideError(ui.formError);
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
  if (node === ui.formError) ui.send.disabled = true;
}

function hideError(node) {
  node.hidden = true;
  if (node === ui.formError) ui.send.disabled = queue.length === 0;
}

// --- Glisser-deposer ---------------------------------------------------------

ui.dropzone.addEventListener('click', () => ui.input.click());
ui.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ui.input.click(); }
});
ui.input.addEventListener('change', () => {
  addFiles(ui.input.files);
  ui.input.value = '';
});

// Le choix d'un dossier passe par un champ distinct : `webkitdirectory` et la
// sélection multiple de fichiers ne cohabitent pas dans le même élément.
$('#pick-folder').addEventListener('click', () => ui.dirInput.click());
ui.dirInput.addEventListener('change', () => {
  addFiles(ui.dirInput.files); // chaque fichier porte son webkitRelativePath
  ui.dirInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    ui.dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'dragleave' && e.relatedTarget) return;
    ui.dropzone.classList.remove('is-over');
  });
}
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  addFiles(await collectDropped(e.dataTransfer));
});

ui.clearAll.addEventListener('click', () => { queue = []; renderQueue(); });

// --- Appels API --------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(transfer ? { 'x-owner-token': transfer.ownerToken } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/** Envoie un bloc chiffre a la position `offset` du fichier chiffre. */
async function putBlock(item, offset, block) {
  const controller = new AbortController();
  activeAbort = controller;
  let res;
  try {
    res = await fetch(`/api/transfers/${transfer.id}/files/${item.serverId}`, {
      method: 'PUT',
      headers: {
        'x-owner-token': transfer.ownerToken,
        'x-upload-offset': String(offset),
        'content-type': 'application/octet-stream',
      },
      body: block,
      signal: controller.signal,
    });
  } catch {
    if (cancelled) throw abortError();
    throw Object.assign(new Error('Connexion interrompue.'), { network: true });
  } finally {
    activeAbort = null;
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && Number.isFinite(data.offset)) {
    throw Object.assign(new Error('Reprise nécessaire.'), { offset: data.offset });
  }
  if (!res.ok) throw new Error(data.error || `Échec de l'envoi (${res.status})`);
}

/** Octets chiffres deja recus par le serveur pour ce fichier. */
async function serverOffset(item) {
  try {
    const data = await api(`/api/transfers/${transfer.id}/files/${item.serverId}/status`);
    return Number(data.uploaded) || 0;
  } catch {
    return 0;
  }
}

// --- Taille de bloc et compression -------------------------------------------

const DEBIT_CLE = 'youseal.debit';

/**
 * Taille de bloc choisie d'après le débit observé lors des envois précédents.
 *
 * Elle doit être connue avant la création du transfert, puisque la taille
 * chiffrée en dépend : on se fie donc à la mesure de la dernière fois plutôt
 * que d'ajuster en cours de route. Sur une liaison rapide, de gros blocs
 * suppriment des allers-retours ; sur une liaison lente, de petits blocs font
 * perdre moins de travail à la moindre coupure.
 */
function chooseChunk() {
  let debit = 0;
  try { debit = Number(localStorage.getItem(DEBIT_CLE)) || 0; } catch { /* mode privé */ }

  if (!debit) return FD_CHUNK;                    // première fois : 4 Mio
  if (debit < 1_000_000) return FD_CHUNK / 4;     // moins de 1 Mo/s  -> 1 Mio
  if (debit < 5_000_000) return FD_CHUNK;         // jusqu'à 5 Mo/s   -> 4 Mio
  if (debit < 20_000_000) return FD_CHUNK * 2;    // jusqu'à 20 Mo/s  -> 8 Mio
  return FD_CHUNK_MAX;                            // au-delà          -> 16 Mio
}

function rememberDebit(octets, ms) {
  if (ms < 500 || octets < 1_000_000) return; // trop court pour être significatif
  const mesure = (octets / ms) * 1000;
  try {
    const ancien = Number(localStorage.getItem(DEBIT_CLE)) || mesure;
    // Moyenne glissante : une mesure isolée ne doit pas tout emporter.
    localStorage.setItem(DEBIT_CLE, String(Math.round(ancien * 0.5 + mesure * 0.5)));
  } catch { /* mode privé */ }
}

/**
 * Prépare ce qui sera réellement transmis : le fichier tel quel, ou sa version
 * compressée si l'option est cochée et que le format s'y prête.
 *
 * La compression a lieu avant la création du transfert, car le serveur doit
 * connaître les tailles à l'avance. Elle est donc limitée aux fichiers d'une
 * taille raisonnable : au-delà, le résultat ne tiendrait pas en mémoire.
 */
const COMPRESSION_MAX = 256 * 1024 * 1024;

async function prepareQueue() {
  const compresser = ui.compress.checked;

  for (const item of queue) {
    item.payload = item.file;
    item.stored = item.file.size;
    item.compressed = false;

    if (!compresser || item.file.size > COMPRESSION_MAX) continue;
    if (!fdCompressible(item.path, item.file.type)) continue;

    ui.current.textContent = `Compression de ${item.path}…`;
    try {
      const octets = await fdCompress(item.file);
      // Un gain inférieur à 5 % ne vaut pas la peine d'être décompressé ensuite.
      if (octets.length < item.file.size * 0.95) {
        item.payload = new Blob([octets]);
        item.stored = octets.length;
        item.compressed = true;
      }
    } catch {
      // Compression indisponible ou en échec : on envoie le fichier tel quel.
    }
  }
}

/**
 * Chiffre puis envoie un fichier, bloc par bloc, avec reprise sur coupure.
 *
 * Ce qui circule est `item.payload` — le fichier lui-même, ou sa version
 * compressée. Le découpage suit `transferChunk`, inscrit dans le manifeste pour
 * que le destinataire retrouve exactement les mêmes frontières.
 */
async function uploadItem(item) {
  const size = item.stored;
  const chunks = fdChunkCount(size, transferChunk);
  let index = 0;
  let offset = 0;
  let attempts = 0;

  const rewindTo = (encryptedBytes) => {
    const at = fdChunkAtOffset(size, encryptedBytes, transferChunk);
    index = at.index;
    offset = at.offset;
    item.uploaded = Math.min(index * transferChunk, size);
    updateProgress(item);
  };

  while (index < chunks) {
    if (cancelled) throw abortError();

    const start = index * transferChunk;
    const slice = await item.payload
      .slice(start, start + fdChunkSize(size, index, transferChunk)).arrayBuffer();
    const block = await fdEncryptChunk(transferKey, item.serverId, index, new Uint8Array(slice));

    try {
      await putBlock(item, offset, block);
      offset += block.length;
      index += 1;
      item.uploaded = Math.min(index * transferChunk, size);
      updateProgress(item);
      attempts = 0;
    } catch (err) {
      if (err.aborted) throw err;
      if (Number.isFinite(err.offset)) { rewindTo(err.offset); continue; }
      if (++attempts > MAX_RETRIES || !err.network) throw err;
      await sleep(700 * attempts);
      if (cancelled) throw abortError();
      rewindTo(await serverOffset(item));
    }
  }

  item.done = true;
  updateProgress(item);
}

// --- Progression -------------------------------------------------------------

/** Volume réellement transmis : après compression, il diffère de la taille des fichiers. */
function storedSize(item) {
  return item.stored ?? item.file.size;
}

function updateProgress(current) {
  const total = queue.reduce((sum, item) => sum + storedSize(item), 0);
  const sent = queue.reduce((sum, item) => sum + Math.min(item.uploaded, storedSize(item)), 0);
  const ratio = total ? Math.min(sent / total, 1) : 0;

  ui.fill.style.width = `${ratio * 100}%`;
  ui.pct.textContent = `${Math.round(ratio * 100)} %`;
  ui.detail.textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;

  if (current) {
    ui.current.textContent = current.done
      ? `${current.path} — envoyé`
      : `Chiffrement et envoi de ${current.path}…`;
    const row = ui.filelist.querySelector(`[data-key="${current.key}"]`);
    if (row) {
      row.querySelector('.bar i').style.width =
        `${Math.round((current.uploaded / Math.max(storedSize(current), 1)) * 100)}%`;
      row.classList.toggle('done', current.done);
    }
  }
}

/** Le QR code n'est qu'un raccourci : en cas d'echec, le lien texte suffit. */
function showQr(url) {
  const block = $('#qr');
  try {
    block.querySelector('.qr-code').innerHTML = qrSvg(url);
    block.hidden = false;
  } catch {
    block.hidden = true;
  }
}

function showFingerprint(value) {
  const block = $('#fingerprint');
  block.querySelector('b').textContent = value;
  block.hidden = false;
}

// --- Ouverture sur un autre appareil ------------------------------------------

let pairSession = null;

function resetPairing(transferId, keyText) {
  if (pairSession) pairSession.stop();
  pairSession = null;
  $('#pair-box').hidden = true;
  $('#pair-start').hidden = false;
  $('#pair-start').disabled = false;

  $('#pair-start').onclick = () => {
    $('#pair-start').hidden = true;
    $('#pair-box').hidden = false;
    $('#pair-code').textContent = '······';
    $('#pair-status').textContent = 'Demande du code…';

    pairSession = pairOffer(transferId, keyText, (etat) => {
      if (etat.code) $('#pair-code').textContent = etat.code;
      const messages = {
        attente: 'Saisissez ce code sur l\'autre appareil, rubrique « J\'ai un code ».',
        transmis: 'Appareil connecté — le transfert s\'ouvre là-bas.',
        expire: 'Code expiré. Fermez et rouvrez pour en obtenir un nouveau.',
        erreur: 'L\'appairage a échoué.',
      };
      $('#pair-status').textContent = messages[etat.statut] || '';
      if (etat.statut !== 'attente') $('#pair-code').classList.toggle('done', etat.statut === 'transmis');
    });
  };
}

function showPanel(name) {
  ui.panelForm.hidden = name !== 'form';
  ui.panelUpload.hidden = name !== 'upload';
  ui.panelDone.hidden = name !== 'done';
}

// --- Envoi -------------------------------------------------------------------

ui.send.addEventListener('click', async () => {
  if (!queue.length || uploading) return;
  if (!window.isSecureContext) {
    return showError(ui.formError,
      'Le chiffrement exige une connexion sécurisée (HTTPS ou localhost).');
  }

  cancelled = false;
  uploading = true;
  hideError(ui.uploadError);
  ui.cancel.hidden = true;
  showPanel('upload');
  updateProgress(null);
  ui.current.textContent = 'Génération de la clé…';

  try {
    transferKey = await fdGenerateKey();

    transferChunk = chooseChunk();
    await prepareQueue();
    if (cancelled) throw abortError();

    // Noms, types et message ne quittent le navigateur que chiffres.
    // `stored` est ce qui part réellement : après compression, il diffère de
    // `size`, que le destinataire affiche et retrouve après décompression.
    const manifest = await fdEncryptManifest(transferKey, {
      message: ui.message.value.trim(),
      chunk: transferChunk,
      files: queue.map((item) => ({
        name: item.path,
        type: item.file.type || 'application/octet-stream',
        size: item.file.size,
        stored: item.stored,
        compressed: item.compressed,
      })),
    });

    const created = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({
        encrypted: true,
        manifest,
        files: queue.map((item) => ({ size: fdEncryptedSize(item.stored, transferChunk) })),
        password: ui.password.value || null,
        expiryDays: Number(ui.expiry.value),
        maxDownloads: Number(ui.maxDownloads.value) || null,
        burnAfterReading: ui.burn.checked,
      }),
    });

    transfer = { id: created.id, ownerToken: created.ownerToken };
    created.files.forEach((file, i) => { queue[i].serverId = file.id; });

    const debutEnvoi = Date.now();
    for (const item of queue) {
      if (cancelled) throw abortError();
      await uploadItem(item);
    }
    rememberDebit(queue.reduce((s, i) => s + i.stored, 0), Date.now() - debutEnvoi);

    const done = await api(`/api/transfers/${transfer.id}/complete`, { method: 'POST' });
    transfer.url = `${done.url}#${await fdExportKey(transferKey)}`;

    historyAdd({
      id: transfer.id,
      ownerToken: transfer.ownerToken,
      url: transfer.url,
      createdAt: new Date().toISOString(),
      expiresAt: done.expiresAt,
      fileCount: queue.length,
      size: totalSize(),
      downloads: 0,
    });

    ui.shareLink.value = transfer.url;
    ui.openLink.href = transfer.url;
    showQr(transfer.url);
    showFingerprint(await fdFingerprint(transferKey));
    resetPairing(transfer.id, await fdExportKey(transferKey));
    ui.doneSub.textContent =
      `${queue.length} fichier${queue.length > 1 ? 's' : ''} · ${formatBytes(totalSize())} · ${remainingLabel(done.expiresAt)}`;
    showPanel('done');
    ui.shareLink.select();
  } catch (err) {
    if (err.aborted || cancelled) {
      if (transfer) api(`/api/transfers/${transfer.id}`, { method: 'DELETE' }).catch(() => {});
      transfer = null;
      transferKey = null;
      queue.forEach((item) => {
    item.uploaded = 0; item.done = false; item.serverId = null;
    item.payload = null; item.stored = undefined; item.compressed = false;
  });
      renderQueue();
      showPanel('form');
      toast('Envoi annulé');
      return;
    }
    showError(ui.uploadError, err.message);
    ui.cancel.hidden = false;
  } finally {
    uploading = false;
  }
});

// Seule issue de l'écran d'erreur : on abandonne le transfert incomplet, qui
// serait de toute façon purgé, et on revient au formulaire.
ui.cancel.addEventListener('click', () => {
  if (transfer) api(`/api/transfers/${transfer.id}`, { method: 'DELETE' }).catch(() => {});
  transfer = null;
  transferKey = null;
  queue.forEach((item) => {
    item.uploaded = 0; item.done = false; item.serverId = null;
    item.payload = null; item.stored = undefined; item.compressed = false;
  });
  ui.cancel.hidden = true;
  hideError(ui.uploadError);
  renderQueue();
  showPanel('form');
});

// --- Ecran final -------------------------------------------------------------

ui.copy.addEventListener('click', async () => {
  const ok = await copyText(ui.shareLink.value);
  toast(ok ? 'Lien copié — il contient la clé de déchiffrement' : 'Copie impossible');
});

ui.newTransfer.addEventListener('click', () => {
  queue = [];
  transfer = null;
  transferKey = null;
  ui.message.value = '';
  ui.password.value = '';
  ui.maxDownloads.value = '';
  ui.burn.checked = false;
  ui.compress.checked = false;
  ui.maxDownloads.disabled = false;
  ui.cancel.hidden = true;
  renderQueue();
  showPanel('form');
});

// Les deux réglages se contrediraient : la destruction impose déjà une seule
// récupération, un plafond distinct n'aurait pas de sens.
ui.burn.addEventListener('change', () => {
  ui.maxDownloads.disabled = ui.burn.checked;
  if (ui.burn.checked) ui.maxDownloads.value = '';
});

ui.deleteTransfer.addEventListener('click', async () => {
  if (!transfer || !confirm('Supprimer définitivement ce transfert ?')) return;
  try {
    await api(`/api/transfers/${transfer.id}`, { method: 'DELETE' });
    historyRemove(transfer.id);
    toast('Transfert supprimé');
    ui.newTransfer.click();
  } catch (err) {
    toast(err.message);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (uploading) { e.preventDefault(); e.returnValue = ''; }
});

// --- Saisie d'un code venu d'un autre appareil --------------------------------

const redeemInput = $('#redeem-code');
const redeemError = $('#redeem-error');

async function redeem() {
  const code = redeemInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  redeemError.hidden = true;
  if (code.length !== 6) {
    redeemError.textContent = 'Le code compte six caractères.';
    redeemError.hidden = false;
    return;
  }

  const bouton = $('#redeem-go');
  bouton.disabled = true;
  bouton.textContent = 'Connexion…';
  try {
    const adresse = await pairRedeem(code, (etat) => {
      bouton.textContent = etat.statut === 'attente-cle' ? 'Réception…' : 'Connexion…';
    });
    location.href = adresse;
  } catch (err) {
    redeemError.textContent = err.message;
    redeemError.hidden = false;
    bouton.disabled = false;
    bouton.textContent = 'Ouvrir';
  }
}

$('#redeem-go').addEventListener('click', redeem);
redeemInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') redeem(); });
redeemInput.addEventListener('input', () => {
  redeemInput.value = redeemInput.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
});

// --- Initialisation ----------------------------------------------------------

fetch('/api/health')
  .then((res) => res.json())
  .then((data) => {
    limits = data.limits;
    checkLimits();
  })
  .catch(() => {});
