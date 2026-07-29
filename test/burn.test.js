'use strict';

/*
 * Mode « destruction après téléchargement ».
 *
 * Le transfert doit disparaître dès que chaque fichier a été récupéré en
 * entier — et surtout pas avant, sous peine de priver le destinataire de la
 * moitié de son envoi.
 */

const crypto = require('crypto');

module.exports = async function run({ base, storageDir, assert }) {
  const fs = require('fs');
  const path = require('path');

  // Le marquage a lieu une fois le flux terminé, donc juste après que le client
  // a reçu le dernier octet : il faut laisser au serveur le temps d'écrire.
  const settle = () => new Promise((r) => setTimeout(r, 400));

  const contenus = [crypto.randomBytes(40000), crypto.randomBytes(9000)];

  const creer = async (burn) => {
    const res = await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: contenus.map((c, i) => ({ name: `f${i}.bin`, size: c.length })),
        burnAfterReading: burn,
      }),
    });
    const t = await res.json();
    const owner = { 'x-owner-token': t.ownerToken };
    for (let i = 0; i < contenus.length; i++) {
      await fetch(`${base}/api/transfers/${t.id}/files/${t.files[i].id}`, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': '0' }, body: contenus[i],
      });
    }
    await fetch(`${base}/api/transfers/${t.id}/complete`, { method: 'POST', headers: owner });
    return t;
  };

  // --- deux fichiers : le premier téléchargement ne doit rien détruire
  const t = await creer(true);
  const vue = await (await fetch(`${base}/api/transfers/${t.id}`)).json();
  assert(vue.burnAfterReading === true, 'le mode est annoncé au destinataire');

  let r = await fetch(`${base}/api/transfers/${t.id}/files/${t.files[0].id}/download`);
  const premier = Buffer.from(await r.arrayBuffer());
  assert(r.ok && premier.equals(contenus[0]), 'premier fichier récupéré intact');
  await settle();

  const apres = await fetch(`${base}/api/transfers/${t.id}`);
  assert(apres.status === 200, 'le transfert survit tant qu\'il reste un fichier à récupérer');
  const etat = await apres.json();
  assert(etat.files[0].fetched === true && etat.files[1].fetched === false,
    'seul le fichier récupéré est marqué');

  r = await fetch(`${base}/api/transfers/${t.id}/files/${t.files[1].id}/download`);
  const second = Buffer.from(await r.arrayBuffer());
  assert(r.ok && second.equals(contenus[1]), 'second fichier récupéré intact');
  await settle();
  assert((await fetch(`${base}/api/transfers/${t.id}`)).status === 404,
    'le transfert est détruit une fois tout récupéré');
  assert(!fs.existsSync(path.join(storageDir, t.id)),
    'les fichiers ont bien disparu du disque');

  // --- une requête partielle ne doit pas déclencher la destruction
  const partiel = await creer(true);
  for (const f of partiel.files) {
    const morceau = await fetch(`${base}/api/transfers/${partiel.id}/files/${f.id}/download`,
      { headers: { range: 'bytes=0-99' } });
    await morceau.arrayBuffer();
  }
  await settle();
  assert((await fetch(`${base}/api/transfers/${partiel.id}`)).status === 200,
    'un téléchargement partiel (Range) ne détruit rien');

  // --- l'archive ZIP récupère tout d'un coup, donc détruit tout
  r = await fetch(`${base}/api/transfers/${partiel.id}/download`);
  const zip = Buffer.from(await r.arrayBuffer());
  assert(r.ok && zip.subarray(0, 2).toString() === 'PK', 'archive ZIP complète');
  await settle();
  assert((await fetch(`${base}/api/transfers/${partiel.id}`)).status === 404,
    'le téléchargement groupé détruit le transfert');

  // --- sans le mode, rien ne disparaît
  const normal = await creer(false);
  for (const f of normal.files) {
    const rep = await fetch(`${base}/api/transfers/${normal.id}/files/${f.id}/download`);
    await rep.arrayBuffer();
  }
  await settle();
  assert((await fetch(`${base}/api/transfers/${normal.id}`)).status === 200,
    'sans le mode, le transfert reste disponible après téléchargement');

  await fetch(`${base}/api/transfers/${normal.id}`, {
    method: 'DELETE', headers: { 'x-owner-token': normal.ownerToken },
  });
};
