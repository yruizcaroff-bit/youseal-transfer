'use strict';

/*
 * Bascule clair / sombre.
 *
 * Sans choix explicite, on suit le réglage du système — c'est la feuille de
 * style qui s'en charge. Dès que l'utilisateur touche au bouton, son choix est
 * mémorisé et prime.
 *
 * Ce script est chargé dans l'en-tête, avant le rendu : appliqué plus tard, le
 * thème clair apparaîtrait brièvement avant d'être remplacé.
 */

(() => {
  const CLE = 'youseal.theme';

  const lire = () => {
    try {
      const v = localStorage.getItem(CLE);
      return v === 'dark' || v === 'light' ? v : null;
    } catch {
      return null; // mode privé
    }
  };

  const appliquer = (theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  };

  appliquer(lire());

  const systemeSombre = () =>
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  const estSombre = () => (lire() || (systemeSombre() ? 'dark' : 'light')) === 'dark';

  document.addEventListener('DOMContentLoaded', () => {
    const bouton = document.querySelector('#theme-toggle');
    if (!bouton) return;

    const rafraichir = () => {
      const sombre = estSombre();
      bouton.setAttribute('aria-pressed', String(sombre));
      bouton.title = sombre ? 'Passer en thème clair' : 'Passer en thème sombre';
      bouton.setAttribute('aria-label', bouton.title);
      // Une lune quand il fait clair (ce vers quoi on bascule), un soleil sinon.
      bouton.innerHTML = sombre
        ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
          + '<circle cx="12" cy="12" r="4.2" fill="currentColor"/>'
          + '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2'
          + 'M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" '
          + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">'
          + '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.4 8.4 0 1 0 10.5 10.5z" '
          + 'fill="currentColor"/></svg>';
    };

    rafraichir();

    bouton.addEventListener('click', () => {
      const cible = estSombre() ? 'light' : 'dark';
      try { localStorage.setItem(CLE, cible); } catch { /* mode privé */ }
      appliquer(cible);
      rafraichir();
    });
  });
})();
