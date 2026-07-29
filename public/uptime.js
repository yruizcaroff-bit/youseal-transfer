'use strict';

/*
 * Durée de fonctionnement sans interruption, depuis le dernier démarrage du
 * service. Volontairement pas de « taux de disponibilité » : une valeur
 * calculée par le serveur lui-même, forcément absent pendant ses propres pannes,
 * ne mesurerait rien d'honnête.
 */

(() => {
  const cible = document.querySelector('#uptime');
  if (!cible) return;

  const format = (debut) => {
    const ms = Date.now() - new Date(debut).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const heures = Math.floor(minutes / 60);
    if (heures < 24) return `${heures} h`;
    const jours = Math.floor(heures / 24);
    return `${jours} j ${heures % 24} h`;
  };

  const peindre = (data) => {
    if (data.startedAt) cible.textContent = format(data.startedAt);
  };

  fetch('/api/stats').then((r) => r.json()).then(peindre).catch(() => {});

  if (typeof EventSource === 'function') {
    const source = new EventSource('/api/stats/stream');
    source.onmessage = (event) => {
      try { peindre(JSON.parse(event.data)); } catch { /* ignore */ }
    };
  }
})();
