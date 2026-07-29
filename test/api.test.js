'use strict';

/* Parcours complet d'un transfert non chiffré, via l'API seule. */

const crypto = require('crypto');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = async function run({ base, assert }) {
  const files = [
    { name: 'rapport été 2026.txt', data: Buffer.from('Bonjour — accents éàü\n'.repeat(50), 'utf8') },
    { name: 'gros-fichier.bin', data: crypto.randomBytes(6 * 1024 * 1024) },
    { name: 'gros-fichier.bin', data: crypto.randomBytes(1024) }, // doublon volontaire
  ];

  let res = await fetch(`${base}/api/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: files.map((f) => ({ name: f.name, size: f.data.length })),
      message: 'Voici les fichiers',
      password: 'secret123',
      expiryDays: 2,
    }),
  });
  const created = await res.json();
  assert(res.status === 201 && created.id && created.ownerToken, 'création du transfert');
  const owner = { 'x-owner-token': created.ownerToken };

  for (let i = 0; i < files.length; i++) {
    const id = created.files[i].id;
    const data = files[i].data;
    const url = `${base}/api/transfers/${created.id}/files/${id}`;

    if (i === 1) {
      const half = Math.floor(data.length / 2);
      let r = await fetch(url, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': '0' }, body: data.subarray(0, half),
      });
      assert(r.ok, 'envoi partiel du fichier 2');

      r = await fetch(`${url}/status`, { headers: owner });
      assert((await r.json()).uploaded === half, 'état de reprise exact');

      r = await fetch(url, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': String(half + 1) }, body: data.subarray(0, 10),
      });
      assert(r.status === 409 && (await r.json()).offset === half,
        'refus d\'un décalage au-delà du reçu');

      r = await fetch(url, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': '100' }, body: data.subarray(100, 200),
      });
      assert(r.ok && (await r.json()).uploaded === 200, 'troncature puis reprise en deçà');

      r = await fetch(url, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': '200' }, body: data.subarray(200),
      });
      assert(r.ok && (await r.json()).done === true, 'fin de l\'envoi du fichier 2');
    } else {
      const r = await fetch(url, {
        method: 'PUT', headers: { ...owner, 'x-upload-offset': '0' }, body: data,
      });
      assert(r.ok, `envoi du fichier ${i + 1}`);
    }
  }

  res = await fetch(`${base}/api/transfers/${created.id}/complete`, { method: 'POST', headers: owner });
  const done = await res.json();
  assert(res.ok && done.url.endsWith(`/t/${created.id}`), 'finalisation');

  res = await fetch(`${base}/api/transfers/${created.id}`);
  assert(res.status === 401, 'accès refusé sans mot de passe');

  res = await fetch(`${base}/api/transfers/${created.id}/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'mauvais' }),
  });
  assert(res.status === 401, 'mauvais mot de passe rejeté');

  res = await fetch(`${base}/api/transfers/${created.id}/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secret123' }),
  });
  const { token } = await res.json();
  assert(res.ok && token, 'jeton d\'accès obtenu');

  const key = encodeURIComponent(token);
  const view = await (await fetch(`${base}/api/transfers/${created.id}?k=${key}`)).json();
  assert(view.files.length === 3 && view.protected === true && view.password === undefined,
    'vue publique sans données sensibles');

  for (let i = 0; i < files.length; i++) {
    const r = await fetch(`${base}/api/transfers/${created.id}/files/${view.files[i].id}/download?k=${key}`);
    const buf = Buffer.from(await r.arrayBuffer());
    assert(r.ok && sha(buf) === sha(files[i].data), `contenu identique pour ${files[i].name}`);
    assert(/filename\*=UTF-8''/.test(r.headers.get('content-disposition')),
      'nom de fichier UTF-8 dans l\'en-tête');
  }

  let r = await fetch(`${base}/api/transfers/${created.id}/files/${view.files[1].id}/download?k=${key}`,
    { headers: { range: 'bytes=100-199' } });
  const part = Buffer.from(await r.arrayBuffer());
  assert(r.status === 206 && part.equals(files[1].data.subarray(100, 200)),
    'reprise de téléchargement (Range)');

  r = await fetch(`${base}/api/transfers/${created.id}/download?k=${key}`);
  const zip = Buffer.from(await r.arrayBuffer());
  assert(r.ok && zip.length === Number(r.headers.get('content-length')),
    `taille ZIP annoncée exacte (${zip.length} octets)`);
  assert(zip.subarray(0, 2).toString() === 'PK', 'signature ZIP valide');

  // 3 fichiers + 1 ZIP ; une reprise partielle (Range) ne compte pas
  const after = await (await fetch(`${base}/api/transfers/${created.id}?k=${key}`)).json();
  assert(after.downloads === 4, `compteur de téléchargements = ${after.downloads}`);

  r = await fetch(`${base}/api/transfers/${created.id}`, { method: 'DELETE' });
  assert(r.status === 403, 'suppression refusée sans jeton propriétaire');
  r = await fetch(`${base}/api/transfers/${created.id}`, { method: 'DELETE', headers: owner });
  assert(r.ok, 'suppression par le propriétaire');
  r = await fetch(`${base}/api/transfers/${created.id}`);
  assert(r.status === 404, 'transfert bien supprimé');
};
