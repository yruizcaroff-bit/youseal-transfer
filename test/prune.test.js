'use strict';

/*
 * Purge d'urgence du stockage.
 *
 * Instance dédiée : seuil à 200 000 octets, 100 000 à libérer.
 *
 * Ce qui doit être vrai : ce sont les plus anciens qui partent, on s'arrête dès
 * que la quantité demandée est libérée, et les récents survivent. Une purge qui
 * emporterait tout serait aussi inacceptable qu'une purge qui ne libère rien.
 */

const crypto = require('crypto');

module.exports = async function run({ base, assert }) {
  const deposer = async (taille) => {
    const data = crypto.randomBytes(taille);
    const res = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'x.bin', size: data.length }] }),
    });
    if (res.status !== 201) return { refuse: res.status };
    const t = await res.json();
    const owner = { 'x-owner-token': t.ownerToken };
    await fetch(`${base}/api/transfers/${t.id}/files/${t.files[0].id}`, {
      method: 'PUT', headers: { ...owner, 'x-upload-offset': '0' }, body: data,
    });
    await fetch(`${base}/api/transfers/${t.id}/complete`, { method: 'POST', headers: owner });
    return t;
  };

  const existe = async (id) => (await fetch(`${base}/api/transfers/${id}`)).status === 200;

  // Six dépôts de 40 000 octets : le seuil de 200 000 est franchi au cinquième.
  const depots = [];
  for (let i = 0; i < 6; i++) {
    const t = await deposer(40000);
    assert(!t.refuse, `dépôt ${i + 1} accepté`);
    depots.push(t);
    // Les dates de dépôt doivent différer pour que « le plus ancien » ait un sens.
    await new Promise((r) => setTimeout(r, 1100));
  }

  await new Promise((r) => setTimeout(r, 1500)); // la purge est asynchrone

  const survivants = [];
  for (const t of depots) if (await existe(t.id)) survivants.push(t.id);

  assert(survivants.length > 0 && survivants.length < depots.length,
    `purge partielle : ${survivants.length} transfert(s) sur ${depots.length} conservés`);

  const disparus = depots.filter((t) => !survivants.includes(t.id));
  const indexDisparus = disparus.map((t) => depots.indexOf(t));
  const indexSurvivants = survivants.map((id) => depots.findIndex((t) => t.id === id));

  assert(Math.max(...indexDisparus) < Math.min(...indexSurvivants),
    `ce sont les plus anciens qui partent (effacés : ${indexDisparus.map((i) => i + 1).join(', ')})`);

  assert(disparus.length * 40000 >= 100000,
    `au moins la quantité demandée est libérée (${disparus.length * 40000} octets)`);

  assert(disparus.length <= 3,
    `on ne libère pas plus que nécessaire (${disparus.length} effacés, 3 auraient suffi)`);

  const snap = await (await fetch(`${base}/api/stats`)).json();
  assert(snap.activeTransfers === survivants.length,
    `les jauges suivent la purge (${snap.activeTransfers} actifs)`);

  // Le service reste utilisable après purge : c'est tout son objet.
  const apres = await deposer(40000);
  assert(!apres.refuse, 'un nouvel envoi reste possible après la purge');
};
