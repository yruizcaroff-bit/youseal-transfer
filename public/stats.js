'use strict';

/*
 * Statistiques d'utilisation en direct.
 *
 * Le serveur pousse les nouvelles valeurs par Server-Sent Events : pas
 * d'interrogation en boucle, l'affichage change au moment ou un transfert est
 * scelle ou telecharge. Si le flux tombe, on repasse sur une lecture ponctuelle.
 */

(() => {
  const root = document.querySelector('#stats');
  if (!root) return;

  const cells = new Map();
  for (const node of root.querySelectorAll('[data-stat]')) {
    cells.set(node.dataset.stat, node);
  }
  const dot = root.querySelector('.live');

  const previous = new Map();

  function paint(data) {
    for (const [name, node] of cells) {
      const value = data[name];
      if (value === undefined) continue;

      if (name === 'since') {
        node.textContent = new Date(value).toLocaleDateString('fr-FR',
          { day: 'numeric', month: 'long', year: 'numeric' });
        continue;
      }
      if (name === 'bytes' || name === 'activeBytes') {
        node.textContent = formatBytes(value);
        continue;
      }
      countUp(node, previous.get(name) ?? 0, value);
      previous.set(name, value);
    }
  }

  /** Petite animation entre l'ancienne et la nouvelle valeur. */
  function countUp(node, from, to) {
    // Onglet masque : requestAnimationFrame est suspendu, on ecrit directement
    // la valeur finale plutot que de laisser un compteur perime a l'ecran.
    if (from === to || document.visibilityState !== 'visible') {
      node.textContent = to.toLocaleString('fr-FR');
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const ratio = Math.min((now - start) / 450, 1);
      const eased = 1 - (1 - ratio) ** 3;
      node.textContent = Math.round(from + (to - from) * eased).toLocaleString('fr-FR');
      if (ratio < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function setLive(on) {
    if (dot) dot.classList.toggle('is-on', on);
  }

  if (typeof EventSource === 'function') {
    const source = new EventSource('/api/stats/stream');
    source.onmessage = (event) => {
      try { paint(JSON.parse(event.data)); setLive(true); } catch { /* ignore */ }
    };
    source.onerror = () => setLive(false);
    source.onopen = () => setLive(true);
  } else {
    fetch('/api/stats').then((r) => r.json()).then(paint).catch(() => {});
  }
})();
