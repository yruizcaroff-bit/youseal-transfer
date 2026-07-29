'use strict';

/*
 * Partage du site — sans script tiers ni bouton de reseau social.
 *
 * L'adresse est lue depuis la page elle-meme : le lien reste juste, que le
 * service tourne sur youseal.site, sur un serveur local ou ailleurs.
 */

(() => {
  const field = document.querySelector('#site-url');
  if (!field) return;

  const url = location.origin;
  const titre = 'YouSeal';
  const texte = 'YouSeal — envoyer des fichiers chiffrés de bout en bout, gratuitement et sans compte.';

  field.value = url;

  document.querySelector('#copy-url').addEventListener('click', async () => {
    const ok = await copyText(url);
    toast(ok ? 'Adresse copiée' : 'Copie impossible');
  });

  document.querySelector('#share-mail').href =
    `mailto:?subject=${encodeURIComponent(titre)}&body=${encodeURIComponent(`${texte}\n\n${url}`)}`;

  const qr = document.querySelector('#qr-site');
  try {
    qr.querySelector('.qr-code').innerHTML = qrSvg(url);
    qr.hidden = false;
  } catch {
    qr.hidden = true;
  }

  // Menu de partage natif du système, uniquement s'il existe.
  const native = document.querySelector('#share-native');
  if (typeof navigator.share === 'function') {
    native.hidden = false;
    native.addEventListener('click', async () => {
      try {
        await navigator.share({ title: titre, text: texte, url });
      } catch { /* partage annulé par l'utilisateur */ }
    });
  }
})();
