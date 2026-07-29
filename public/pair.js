'use strict';

/*
 * Appairage par code court.
 *
 * Le code ne transporte pas la clé du transfert : il n'identifie qu'un
 * rendez-vous. Les deux navigateurs y déposent une clé publique éphémère,
 * en dérivent un secret commun par ECDH (P-256), et l'expéditeur s'en sert pour
 * emballer la clé du transfert.
 *
 * Le serveur voit passer deux clés publiques et un paquet scellé. Il lui
 * manque les deux clés privées, qui ne quittent jamais leur navigateur : il ne
 * peut donc pas l'ouvrir. Le chiffrement de bout en bout reste entier.
 */

const PAIR_POLL_MS = 1500;

async function pairGenerateKeys() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}

async function pairExportPublic(pair) {
  return fdToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
}

/** Secret commun aux deux appareils, dérivé sans jamais transiter. */
async function pairSharedKey(privateKey, publicKeyText) {
  const peer = await crypto.subtle.importKey(
    'raw', fdFromBase64Url(publicKeyText), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const PAIR_AAD = new TextEncoder().encode('youseal-pairing');

async function pairSeal(sharedKey, keyText) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PAIR_AAD },
    sharedKey,
    new TextEncoder().encode(keyText)
  ));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return fdToBase64Url(out);
}

async function pairOpen(sharedKey, wrapped) {
  const bytes = fdFromBase64Url(wrapped);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: PAIR_AAD },
    sharedKey,
    bytes.subarray(12)
  );
  return new TextDecoder().decode(plain);
}

async function pairRequest(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
}

// --- Côté expéditeur ----------------------------------------------------------

/**
 * Ouvre un rendez-vous et attend le second appareil.
 * @param {(etat: {code?: string, statut: string}) => void} onChange
 * @returns {{stop: () => void}}
 */
function pairOffer(transferId, keyText, onChange) {
  let stopped = false;
  const stop = () => { stopped = true; };

  (async () => {
    const keys = await pairGenerateKeys();
    const rendezvous = await pairRequest('/api/pairings', {
      method: 'POST',
      body: JSON.stringify({ transferId, senderPublicKey: await pairExportPublic(keys) }),
    });
    if (stopped) return;
    onChange({ code: rendezvous.code, statut: 'attente' });

    const limite = Date.now() + 10 * 60 * 1000;
    while (!stopped && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
      if (stopped) return;

      let etat;
      try {
        etat = await pairRequest(
          `/api/pairings/${rendezvous.code}?token=${encodeURIComponent(rendezvous.token)}`);
      } catch {
        onChange({ code: rendezvous.code, statut: 'expire' });
        return;
      }
      if (!etat.claimed) continue;

      // Le second appareil s'est présenté : on lui emballe la clé.
      const shared = await pairSharedKey(keys.privateKey, etat.receiverPublicKey);
      await pairRequest(`/api/pairings/${rendezvous.code}/key`, {
        method: 'PUT',
        body: JSON.stringify({ token: rendezvous.token, wrappedKey: await pairSeal(shared, keyText) }),
      });
      onChange({ code: rendezvous.code, statut: 'transmis' });
      return;
    }
    if (!stopped) onChange({ statut: 'expire' });
  })().catch(() => onChange({ statut: 'erreur' }));

  return { stop };
}

// --- Côté destinataire --------------------------------------------------------

/** Saisit un code et en retire l'adresse complète du transfert, clé comprise. */
async function pairRedeem(code, onChange) {
  const keys = await pairGenerateKeys();
  onChange({ statut: 'connexion' });

  const claim = await pairRequest(`/api/pairings/${encodeURIComponent(code)}/claim`, {
    method: 'POST',
    body: JSON.stringify({ publicKey: await pairExportPublic(keys) }),
  });

  onChange({ statut: 'attente-cle' });
  const shared = await pairSharedKey(keys.privateKey, claim.senderPublicKey);
  const limite = Date.now() + 2 * 60 * 1000;

  while (Date.now() < limite) {
    const data = await pairRequest(
      `/api/pairings/${encodeURIComponent(code)}/key?token=${encodeURIComponent(claim.token)}`);
    if (!data.pending) {
      const keyText = await pairOpen(shared, data.wrappedKey);
      return `/t/${data.transferId}#${keyText}`;
    }
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
  }
  throw new Error('L\'autre appareil n\'a pas répondu à temps.');
}
