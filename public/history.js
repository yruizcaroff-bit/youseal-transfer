'use strict';

/*
 * « Mes transferts » — memoire locale des envois.
 *
 * Le jeton proprietaire n'existe que dans la page qui a fait l'envoi : sans
 * cette liste, fermer l'onglet revient a perdre la possibilite de supprimer son
 * propre transfert avant son expiration.
 *
 * Attention : les liens conserves ici contiennent la cle de dechiffrement. Ils
 * ne quittent pas le navigateur, mais quiconque a acces a ce profil peut les
 * lire — d'ou le bouton « Vider la liste ».
 */

const HISTORY_KEY = 'youseal.transfers';
const HISTORY_MAX = 50;

function historyLoad() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function historySave(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* mode prive ou quota plein : on continue sans historique */ }
}

function historyAdd(entry) {
  const list = historyLoad().filter((item) => item.id !== entry.id);
  list.unshift(entry);
  historySave(list);
  historyRender();
}

function historyRemove(id) {
  historySave(historyLoad().filter((item) => item.id !== id));
  historyRender();
}

/**
 * Retire les entrees dont le transfert n'existe plus cote serveur (expire,
 * supprime, ou serveur reinitialise) et rafraichit le nombre de telechargements.
 */
async function historySync() {
  const list = historyLoad();
  if (!list.length) return;

  const checked = await Promise.all(list.map(async (item) => {
    try {
      const res = await fetch(`/api/transfers/${item.id}`, {
        headers: { 'x-owner-token': item.ownerToken },
      });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) return item; // probleme reseau : on garde l'entree
      const data = await res.json();
      return { ...item, downloads: data.downloads, expiresAt: data.expiresAt };
    } catch {
      return item;
    }
  }));

  historySave(checked.filter(Boolean));
  historyRender();
}

function historyRender() {
  const section = document.querySelector('#history');
  if (!section) return;

  const list = historyLoad();
  section.hidden = list.length === 0;

  const container = section.querySelector('#history-list');
  container.innerHTML = '';

  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div class="meta">
        <div class="name"></div>
        <div class="size"></div>
      </div>
      <div class="history-actions">
        <button type="button" class="link-btn" data-act="copy">Copier</button>
        <button type="button" class="link-btn" data-act="open">Ouvrir</button>
        <button type="button" class="link-btn danger" data-act="delete">Supprimer</button>
      </div>`;

    const count = item.fileCount || 1;
    row.querySelector('.name').textContent =
      `${count} fichier${count > 1 ? 's' : ''} · ${formatBytes(item.size || 0)}`;
    row.querySelector('.size').textContent =
      `${remainingLabel(item.expiresAt)} · ${item.downloads || 0} téléchargement${(item.downloads || 0) > 1 ? 's' : ''}`;

    row.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      const ok = await copyText(item.url);
      toast(ok ? 'Lien copié — il contient la clé' : 'Copie impossible');
    });
    row.querySelector('[data-act="open"]').addEventListener('click', () => {
      window.open(item.url, '_blank', 'noopener');
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!confirm('Supprimer définitivement ce transfert ?')) return;
      try {
        const res = await fetch(`/api/transfers/${item.id}`, {
          method: 'DELETE',
          headers: { 'x-owner-token': item.ownerToken },
        });
        // 404 : deja disparu cote serveur, on nettoie quand meme la liste.
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Erreur ${res.status}`);
        }
        historyRemove(item.id);
        toast('Transfert supprimé');
      } catch (err) {
        toast(err.message);
      }
    });

    container.appendChild(row);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const clear = document.querySelector('#history-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      if (!confirm('Vider la liste ? Les transferts resteront en ligne, mais vous ne pourrez plus les supprimer depuis ce navigateur.')) return;
      historySave([]);
      historyRender();
      toast('Liste vidée');
    });
  }
  historyRender();
  historySync();
});
