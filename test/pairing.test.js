'use strict';

/*
 * Appairage par code court.
 *
 * L'enjeu n'est pas seulement que la clé arrive : c'est que le serveur ne
 * puisse pas l'ouvrir. Ce test rejoue l'échange complet avec les mêmes
 * primitives que le navigateur, puis vérifie qu'un observateur placé à la
 * place du serveur reste impuissant.
 */

const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const AAD = new TextEncoder().encode('youseal-pairing');

const toB64 = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

const genKeys = () => subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
const exportPub = async (pair) => toB64(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));

async function shared(privateKey, publicText) {
  const peer = await subtle.importKey(
    'raw', fromB64(publicText), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return subtle.deriveKey({ name: 'ECDH', public: peer }, privateKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(text)));
  return toB64(Buffer.concat([Buffer.from(iv), Buffer.from(out)]));
}

async function open(key, wrapped) {
  const bytes = fromB64(wrapped);
  return new TextDecoder().decode(await subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: AAD }, key, bytes.subarray(12)));
}

module.exports = async function run({ base, assert }) {
  const json = async (path, options) => {
    const res = await fetch(`${base}${path}`, {
      headers: { 'content-type': 'application/json' }, ...options,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // --- un transfert réel, pour avoir un identifiant valide
  const contenu = Buffer.from('contenu de test');
  const creation = await json('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ files: [{ name: 'a.txt', size: contenu.length }] }),
  });
  const t = creation.body;
  const owner = { 'x-owner-token': t.ownerToken };
  await fetch(`${base}/api/transfers/${t.id}/files/${t.files[0].id}`, {
    method: 'PUT', headers: { ...owner, 'x-upload-offset': '0' }, body: contenu,
  });
  await fetch(`${base}/api/transfers/${t.id}/complete`, { method: 'POST', headers: owner });

  const cleTransfert = toB64(webcrypto.getRandomValues(new Uint8Array(32)));

  // --- l'expéditeur ouvre un rendez-vous
  const expediteur = await genKeys();
  const rdv = await json('/api/pairings', {
    method: 'POST',
    body: JSON.stringify({ transferId: t.id, senderPublicKey: await exportPub(expediteur) }),
  });
  assert(rdv.status === 201 && /^[0-9A-Z]{6}$/.test(rdv.body.code),
    `code à six caractères délivré (${rdv.body.code})`);

  // --- avant l'arrivée du second appareil
  const avant = await json(`/api/pairings/${rdv.body.code}?token=${encodeURIComponent(rdv.body.token)}`);
  assert(avant.body.claimed === false, 'aucun appareil présenté au départ');

  const vol = await json(`/api/pairings/${rdv.body.code}?token=mauvais-jeton`);
  assert(vol.status === 404, 'un jeton invalide ne permet pas d\'espionner le rendez-vous');

  // --- le destinataire se présente
  const destinataire = await genKeys();
  const claim = await json(`/api/pairings/${rdv.body.code}/claim`, {
    method: 'POST',
    body: JSON.stringify({ publicKey: await exportPub(destinataire) }),
  });
  assert(claim.status === 200 && claim.body.transferId === t.id,
    'le second appareil obtient l\'identifiant du transfert');

  const rejeu = await json(`/api/pairings/${rdv.body.code}/claim`, {
    method: 'POST',
    body: JSON.stringify({ publicKey: await exportPub(await genKeys()) }),
  });
  assert(rejeu.status === 404, 'un code déjà réclamé ne l\'est pas deux fois');

  // --- l'expéditeur emballe la clé
  const apres = await json(`/api/pairings/${rdv.body.code}?token=${encodeURIComponent(rdv.body.token)}`);
  assert(apres.body.claimed === true, 'l\'expéditeur voit l\'arrivée du second appareil');

  const secretExpediteur = await shared(expediteur.privateKey, apres.body.receiverPublicKey);
  const paquet = await seal(secretExpediteur, cleTransfert);
  const depot = await json(`/api/pairings/${rdv.body.code}/key`, {
    method: 'PUT',
    body: JSON.stringify({ token: rdv.body.token, wrappedKey: paquet }),
  });
  assert(depot.status === 200, 'la clé emballée est déposée');

  // --- le destinataire la récupère et l'ouvre
  const collecte = await json(
    `/api/pairings/${rdv.body.code}/key?token=${encodeURIComponent(claim.body.token)}`);
  const secretDestinataire = await shared(destinataire.privateKey, collecte.body.senderPublicKey);
  const lue = await open(secretDestinataire, collecte.body.wrappedKey);
  assert(lue === cleTransfert, 'la clé du transfert traverse intacte');

  // --- ce que peut faire le serveur, qui a tout vu passer
  let serveurImpuissant = false;
  try {
    // Le serveur détient les deux clés publiques et le paquet, mais aucune clé
    // privée : il ne peut pas dériver le secret commun.
    const intrus = await genKeys();
    const faux = await shared(intrus.privateKey, collecte.body.senderPublicKey);
    await open(faux, collecte.body.wrappedKey);
  } catch {
    serveurImpuissant = true;
  }
  assert(serveurImpuissant,
    'avec les seules clés publiques, le paquet reste indéchiffrable');

  // --- le rendez-vous disparaît après usage
  const apresCollecte = await json(
    `/api/pairings/${rdv.body.code}/key?token=${encodeURIComponent(claim.body.token)}`);
  assert(apresCollecte.status === 404, 'le rendez-vous est consommé après récupération');

  const inconnu = await json('/api/pairings/ZZZZZZ/claim', {
    method: 'POST', body: JSON.stringify({ publicKey: await exportPub(await genKeys()) }),
  });
  assert(inconnu.status === 404, 'un code inconnu est refusé');

  await fetch(`${base}/api/transfers/${t.id}`, { method: 'DELETE', headers: owner });
};
