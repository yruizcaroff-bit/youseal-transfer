'use strict';

/*
 * Taille de bloc variable et compression.
 *
 * Ces deux options changent ce qui part sur le réseau sans changer ce que le
 * destinataire récupère : c'est exactement ce que ce test vérifie, en rejouant
 * le parcours complet avec les mêmes modules que le navigateur.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const fd = require('../public/fdcrypto.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = async function run({ base, assert }) {
  // --- le découpage, d'abord, sans réseau
  assert(fd.fdChunk(999) === fd.FD_CHUNK, 'une taille de bloc aberrante retombe sur le défaut');
  assert(fd.fdChunk(undefined) === fd.FD_CHUNK, 'sans indication, le défaut s\'applique');
  assert(fd.fdChunkCount(10 * 1024 * 1024, 1024 * 1024) === 10, 'dix blocs d\'un Mio');
  assert(fd.fdEncryptedSize(1024 * 1024, 1024 * 1024) === 1024 * 1024 + 28,
    'un seul bloc, un seul surcoût');
  assert(fd.fdEncryptedSize(1024 * 1024, 512 * 1024) === 1024 * 1024 + 56,
    'deux blocs, deux surcoûts');

  assert(!fd.fdCompressible('photo.jpg', 'image/jpeg'), 'un JPEG n\'est pas recompressé');
  assert(!fd.fdCompressible('archive.zip', ''), 'une archive n\'est pas recompressée');
  assert(fd.fdCompressible('rapport.txt', 'text/plain'), 'un texte l\'est');
  assert(fd.fdCompressible('dessin.svg', 'image/svg+xml'), 'un SVG l\'est, malgré son type image');

  // --- parcours complet, pour trois découpages et avec ou sans compression
  const texte = Buffer.from('Rapport trimestriel — ligne répétée pour être compressible.\n'.repeat(4000));
  const aleatoire = crypto.randomBytes(300000);

  const scenarios = [
    { titre: 'blocs de 512 Kio', chunk: 512 * 1024, source: texte, compresse: false },
    { titre: 'blocs de 16 Mio', chunk: 16 * 1024 * 1024, source: texte, compresse: false },
    { titre: 'texte compressé', chunk: fd.FD_CHUNK, source: texte, compresse: true },
    { titre: 'aléatoire compressé', chunk: fd.FD_CHUNK, source: aleatoire, compresse: true },
  ];

  for (const scenario of scenarios) {
    const cle = await fd.fdGenerateKey();
    const origine = scenario.source;

    // Ce qui part réellement : la source, ou sa version compressée.
    const charge = scenario.compresse
      ? zlib.deflateRawSync(origine)
      : origine;

    const manifest = await fd.fdEncryptManifest(cle, {
      message: '',
      chunk: scenario.chunk,
      files: [{
        name: 'f.bin', type: '', size: origine.length,
        stored: charge.length, compressed: scenario.compresse,
      }],
    });

    const t = await (await fetch(`${base}/api/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        encrypted: true,
        manifest,
        files: [{ size: fd.fdEncryptedSize(charge.length, scenario.chunk) }],
      }),
    })).json();

    const owner = { 'x-owner-token': t.ownerToken };
    const fileId = t.files[0].id;
    let offset = 0;

    for (let c = 0; c < fd.fdChunkCount(charge.length, scenario.chunk); c++) {
      const debut = c * fd.fdChunk(scenario.chunk);
      const plain = charge.subarray(debut, debut + fd.fdChunkSize(charge.length, c, scenario.chunk));
      const bloc = await fd.fdEncryptChunk(cle, fileId, c, plain);
      const r = await fetch(`${base}/api/transfers/${t.id}/files/${fileId}`, {
        method: 'PUT',
        headers: { ...owner, 'x-upload-offset': String(offset), 'content-type': 'application/octet-stream' },
        body: bloc,
      });
      if (!r.ok) assert(false, `${scenario.titre} : envoi du bloc ${c}`);
      offset += bloc.length;
    }

    const fin = await fetch(`${base}/api/transfers/${t.id}/complete`, { method: 'POST', headers: owner });
    assert(fin.ok, `${scenario.titre} : finalisation`);

    // --- relecture, comme le ferait le destinataire
    const meta = await (await fetch(`${base}/api/transfers/${t.id}`)).json();
    const lu = await fd.fdDecryptManifest(cle, meta.manifest);
    assert(lu.chunk === scenario.chunk, `${scenario.titre} : le découpage est transmis`);

    const r = await fetch(`${base}/api/transfers/${t.id}/files/${meta.files[0].id}/download`);
    let flux = fd.fdStreamFrom(
      fd.fdDecryptStream(cle, meta.files[0].id, lu.files[0].stored, r.body, lu.chunk));
    if (lu.files[0].compressed) flux = fd.fdDecompressStream(flux);

    const restitue = Buffer.from(await new Response(flux).arrayBuffer());
    assert(sha(restitue) === sha(origine),
      `${scenario.titre} : restitué à l'identique (${origine.length} o)`);

    if (scenario.compresse) {
      const gain = ((1 - charge.length / origine.length) * 100).toFixed(0);
      assert(true, `${scenario.titre} : ${charge.length} o transmis pour ${origine.length} (${gain} % de gain)`);
    }

    await fetch(`${base}/api/transfers/${t.id}`, { method: 'DELETE', headers: owner });
  }

  // Un découpage différent de celui annoncé ne doit rien donner de lisible.
  const cle = await fd.fdGenerateKey();
  const bloc = await fd.fdEncryptChunk(cle, 'x', 0, Buffer.from('abc'));
  let refuse = false;
  try { await fd.fdDecryptChunk(cle, 'x', 1, bloc); } catch { refuse = true; }
  assert(refuse, 'un bloc lu sous un autre index reste illisible');
};
