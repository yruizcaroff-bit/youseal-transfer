'use strict';

/*
 * Chiffrement de bout en bout.
 *
 * Rejoue le parcours du navigateur en chargeant les mêmes modules clients que
 * la page, et vérifie sur le disque que le serveur ne détient rien de lisible.
 */

const nodeCrypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fd = require('../public/fdcrypto.js');
const zip = require('../public/zipstream.js');

const sha = (buf) => nodeCrypto.createHash('sha256').update(buf).digest('hex');

module.exports = async function run({ base, storageDir, assert }) {
  const files = [
    { name: 'contrat signé.pdf', type: 'application/pdf', data: nodeCrypto.randomBytes(9 * 1024 * 1024 + 777) },
    { name: 'note.txt', type: 'text/plain', data: Buffer.from('Résumé — accents éàü\n'.repeat(30), 'utf8') },
    { name: 'vide.dat', type: '', data: Buffer.alloc(0) },
  ];

  assert(fd.fdEncryptedSize(0) === 28, 'fichier vide → un bloc de 28 octets');
  assert(fd.fdEncryptedSize(fd.FD_CHUNK) === fd.FD_CHUNK + 28, 'un bloc plein');
  assert(fd.fdEncryptedSize(fd.FD_CHUNK + 1) === fd.FD_CHUNK + 1 + 56, 'deux blocs');

  const key = await fd.fdGenerateKey();
  const keyText = await fd.fdExportKey(key);
  assert(keyText.length === 43, `clé exportée en base64url (${keyText.length} caractères)`);

  const manifest = await fd.fdEncryptManifest(key, {
    message: 'Documents confidentiels',
    files: files.map((f) => ({ name: f.name, type: f.type, size: f.data.length })),
  });

  let res = await fetch(`${base}/api/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      encrypted: true,
      manifest,
      files: files.map((f) => ({ size: fd.fdEncryptedSize(f.data.length) })),
      expiryDays: 2,
    }),
  });
  const created = await res.json();
  assert(res.status === 201, 'création du transfert chiffré');
  const owner = { 'x-owner-token': created.ownerToken };

  const put = (fileId, offset, body) => fetch(`${base}/api/transfers/${created.id}/files/${fileId}`, {
    method: 'PUT',
    headers: { ...owner, 'x-upload-offset': String(offset), 'content-type': 'application/octet-stream' },
    body,
  });

  for (let i = 0; i < files.length; i++) {
    const { data } = files[i];
    const fileId = created.files[i].id;
    let offset = 0;

    for (let c = 0; c < fd.fdChunkCount(data.length); c++) {
      const start = c * fd.FD_CHUNK;
      const plain = data.subarray(start, start + fd.fdChunkSize(data.length, c));
      const block = await fd.fdEncryptChunk(key, fileId, c, plain);

      // Sur le premier fichier, on coupe volontairement au milieu d'un bloc.
      if (i === 0 && c === 1) {
        assert((await put(fileId, offset, block.subarray(0, 5000))).ok,
          'bloc interrompu en cours de route');

        const status = await (await fetch(
          `${base}/api/transfers/${created.id}/files/${fileId}/status`, { headers: owner })).json();
        const at = fd.fdChunkAtOffset(data.length, status.uploaded);
        assert(at.index === 1 && at.offset === offset,
          `recalage sur le bloc ${at.index} (serveur à ${status.uploaded} octets)`);

        assert((await put(fileId, at.offset, block)).ok,
          'reprise : le bloc partiel est tronqué puis réécrit');
        offset += block.length;
        continue;
      }

      const r = await put(fileId, offset, block);
      if (!r.ok) assert(false, `envoi du bloc ${c} : ${(await r.json()).error}`);
      offset += block.length;
    }
  }

  assert((await fetch(`${base}/api/transfers/${created.id}/complete`,
    { method: 'POST', headers: owner })).ok, 'finalisation');

  // --- ce que voit le serveur
  const meta = await (await fetch(`${base}/api/transfers/${created.id}`)).json();
  assert(meta.encrypted === true, 'transfert marqué comme chiffré');
  assert(meta.files.every((f) => /^chiffre-\d+\.bin$/.test(f.name)), 'noms anonymisés côté serveur');
  assert(meta.message === '', 'aucun message en clair côté serveur');
  assert(!JSON.stringify(meta).includes('contrat'), 'aucun nom réel dans la réponse API');

  const stored = fs.readFileSync(path.join(storageDir, created.id, 'meta.json'), 'utf8');
  assert(!stored.includes('contrat') && !stored.includes('Documents confidentiels'),
    'aucune métadonnée en clair sur le disque');
  const storedFile = fs.readFileSync(path.join(storageDir, created.id, 'files', created.files[1].id));
  assert(!storedFile.includes(Buffer.from('Résumé', 'utf8')), 'contenu illisible sur le disque');

  // --- lecture avec la clé
  const imported = await fd.fdImportKey(keyText);
  const read = await fd.fdDecryptManifest(imported, meta.manifest);
  assert(read.message === 'Documents confidentiels', 'message déchiffré');
  assert(read.files.map((f) => f.name).join('|') === files.map((f) => f.name).join('|'),
    'noms de fichiers déchiffrés');

  const plain = async (index) => {
    const r = await fetch(`${base}/api/transfers/${created.id}/files/${meta.files[index].id}/download`);
    return Buffer.from(await new Response(fd.fdStreamFrom(
      fd.fdDecryptStream(imported, meta.files[index].id, files[index].data.length, r.body))).arrayBuffer());
  };

  for (let i = 0; i < files.length; i++) {
    assert(sha(await plain(i)) === sha(files[i].data),
      `${files[i].name} restitué à l'identique (${files[i].data.length} o)`);
  }

  let rejected = false;
  try { await fd.fdDecryptManifest(await fd.fdGenerateKey(), meta.manifest); } catch { rejected = true; }
  assert(rejected, 'une autre clé ne déchiffre rien');

  const victim = path.join(storageDir, created.id, 'files', meta.files[1].id);
  const bytes = fs.readFileSync(victim);
  const backup = Buffer.from(bytes);
  bytes[bytes.length - 30] ^= 0xff;
  fs.writeFileSync(victim, bytes);
  let detected = false;
  try { await plain(1); } catch { detected = true; }
  assert(detected, 'altération du fichier chiffré détectée (tag GCM)');
  fs.writeFileSync(victim, backup);

  assert((await fetch(`${base}/api/transfers/${created.id}/download`)).status === 409,
    'le serveur refuse de générer le ZIP d\'un transfert chiffré');

  // --- archive fabriquée côté client
  const entries = read.files.map((f) => ({ name: f.name, size: f.size }));
  const archive = Buffer.from(await new Response(zip.fdCreateZipStream(entries, async (entry, index) => {
    const r = await fetch(`${base}/api/transfers/${created.id}/files/${meta.files[index].id}/download`);
    return fd.fdStreamFrom(fd.fdDecryptStream(imported, meta.files[index].id, entries[index].size, r.body));
  })).arrayBuffer());
  assert(archive.length === zip.fdZipSize(entries),
    `taille ZIP annoncée exacte (${archive.length} octets)`);
  assert(archive.subarray(0, 2).toString() === 'PK', 'signature ZIP valide');

  await fetch(`${base}/api/transfers/${created.id}`, { method: 'DELETE', headers: owner });
};
