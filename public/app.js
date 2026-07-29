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
let activeAbort = null;
let uploading = false;
let cancelled = false;
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('Envoi annulé.'), { aborted: true });

// --- Selection des fichiers --------------------------------------------------

function addFiles(fileList) {
  for (const file of fileList) {
    const duplicate = queue.some(
      (item) => item.file.name === file.name && item.file.size === file.size
    );
    if (duplicate) continue;
    queue.push({ key: `f${++seq}`, file, serverId: null, uploaded: 0, done: false });
  }
  renderQueue();
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
    row.querySelector('.name').textContent = item.file.name;
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
      `« ${tooBig.file.name} » dépasse la limite de ${formatBytes(limits.maxFileSize)} par fichier.`);
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
document.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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

/** Chiffre puis envoie un fichier, bloc par bloc, avec reprise sur coupure. */
async function uploadItem(item) {
  const size = item.file.size;
  const chunks = fdChunkCount(size);
  let index = 0;
  let offset = 0;
  let attempts = 0;

  const rewindTo = (encryptedBytes) => {
    const at = fdChunkAtOffset(size, encryptedBytes);
    index = at.index;
    offset = at.offset;
    item.uploaded = Math.min(index * FD_CHUNK, size);
    updateProgress(item);
  };

  while (index < chunks) {
    if (cancelled) throw abortError();

    const start = index * FD_CHUNK;
    const slice = await item.file.slice(start, start + fdChunkSize(size, index)).arrayBuffer();
    const block = await fdEncryptChunk(transferKey, item.serverId, index, new Uint8Array(slice));

    try {
      await putBlock(item, offset, block);
      offset += block.length;
      index += 1;
      item.uploaded = Math.min(index * FD_CHUNK, size);
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

function updateProgress(current) {
  const total = totalSize();
  const sent = queue.reduce((sum, item) => sum + Math.min(item.uploaded, item.file.size), 0);
  const ratio = total ? Math.min(sent / total, 1) : 0;

  ui.fill.style.width = `${ratio * 100}%`;
  ui.pct.textContent = `${Math.round(ratio * 100)} %`;
  ui.detail.textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;

  if (current) {
    ui.current.textContent = current.done
      ? `${current.file.name} — envoyé`
      : `Chiffrement et envoi de ${current.file.name}…`;
    const row = ui.filelist.querySelector(`[data-key="${current.key}"]`);
    if (row) {
      row.querySelector('.bar i').style.width =
        `${Math.round((current.uploaded / Math.max(current.file.size, 1)) * 100)}%`;
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

    // Noms, types et message ne quittent le navigateur que chiffres.
    const manifest = await fdEncryptManifest(transferKey, {
      message: ui.message.value.trim(),
      files: queue.map((item) => ({
        name: item.file.name,
        type: item.file.type || 'application/octet-stream',
        size: item.file.size,
      })),
    });

    const created = await api('/api/transfers', {
      method: 'POST',
      body: JSON.stringify({
        encrypted: true,
        manifest,
        files: queue.map((item) => ({ size: fdEncryptedSize(item.file.size) })),
        password: ui.password.value || null,
        expiryDays: Number(ui.expiry.value),
        maxDownloads: Number(ui.maxDownloads.value) || null,
        burnAfterReading: ui.burn.checked,
      }),
    });

    transfer = { id: created.id, ownerToken: created.ownerToken };
    created.files.forEach((file, i) => { queue[i].serverId = file.id; });

    for (const item of queue) {
      if (cancelled) throw abortError();
      await uploadItem(item);
    }

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
    ui.doneSub.textContent =
      `${queue.length} fichier${queue.length > 1 ? 's' : ''} · ${formatBytes(totalSize())} · ${remainingLabel(done.expiresAt)}`;
    showPanel('done');
    ui.shareLink.select();
  } catch (err) {
    if (err.aborted || cancelled) {
      if (transfer) api(`/api/transfers/${transfer.id}`, { method: 'DELETE' }).catch(() => {});
      transfer = null;
      transferKey = null;
      queue.forEach((item) => { item.uploaded = 0; item.done = false; item.serverId = null; });
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
  queue.forEach((item) => { item.uploaded = 0; item.done = false; item.serverId = null; });
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

// --- Initialisation ----------------------------------------------------------

fetch('/api/health')
  .then((res) => res.json())
  .then((data) => {
    limits = data.limits;
    checkLimits();
  })
  .catch(() => {});
