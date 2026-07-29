'use strict';

/*
 * Garde-fous d'usage.
 *
 * Cette suite tourne sur une instance dédiée aux seuils très bas :
 * 3 créations par heure, 2 tentatives de mot de passe, 200 000 octets de
 * capacité, 4 flux de statistiques par adresse.
 */

module.exports = async function run({ base, assert }) {
  const create = (size, extra = {}) => fetch(`${base}/api/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ name: 'f.bin', size }], ...extra }),
  });

  // --- quota de stockage
  let res = await create(150000);
  const first = await res.json();
  assert(res.status === 201, 'premier transfert accepté (150 000 o sur 200 000)');

  res = await create(100000);
  assert(res.status === 507, `quota atteint → 507 (${(await res.json()).error})`);

  let snap = await (await fetch(`${base}/api/stats`)).json();
  assert(snap.reservedBytes === 150000, `place engagée dès la création (${snap.reservedBytes} o)`);

  await fetch(`${base}/api/transfers/${first.id}`, {
    method: 'DELETE', headers: { 'x-owner-token': first.ownerToken },
  });
  snap = await (await fetch(`${base}/api/stats`)).json();
  assert(snap.reservedBytes === 0, 'la suppression libère la place réservée');

  res = await create(100000);
  assert(res.status === 201, 'nouvelle création possible une fois la place libérée');
  const second = await res.json();

  // --- limite de création par adresse : 3 par heure, déjà toutes consommées
  // (une requête refusée pour quota compte quand même comme une tentative).
  res = await create(1000);
  const limited = await res.json();
  assert(res.status === 429, `création au-delà du quota horaire → 429 (${limited.error})`);
  assert(Number(res.headers.get('retry-after')) > 0,
    `en-tête Retry-After présent (${res.headers.get('retry-after')} s)`);

  // --- tentatives de mot de passe : 2 par quart d'heure
  const auth = () => fetch(`${base}/api/transfers/${second.id}/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'faux' }),
  });
  const a1 = await auth();
  const a2 = await auth();
  assert(a1.status !== 429 && a2.status !== 429, 'les deux premières tentatives passent le filtre');
  assert((await auth()).status === 429, 'troisième tentative de mot de passe bloquée → 429');

  // --- flux de statistiques plafonnés par adresse
  const streams = [];
  for (let i = 0; i < 5; i++) streams.push(await fetch(`${base}/api/stats/stream`));
  const codes = streams.map((r) => r.status);
  assert(codes.filter((c) => c === 200).length === 4 && codes[4] === 429,
    `flux SSE plafonnés par adresse (${codes.join(', ')})`);
  for (const s of streams) { try { await s.body.cancel(); } catch { /* déjà fermé */ } }

  // --- modération : suppression sans le jeton de l'expéditeur
  res = await fetch(`${base}/api/transfers/${second.id}`, { method: 'DELETE' });
  assert(res.status === 403, 'suppression refusée sans aucun jeton');

  res = await fetch(`${base}/api/transfers/${second.id}`, {
    method: 'DELETE', headers: { 'x-admin-token': 'mauvais-jeton' },
  });
  assert(res.status === 403, 'jeton de modération invalide refusé');

  res = await fetch(`${base}/api/transfers/${second.id}`, {
    method: 'DELETE', headers: { 'x-admin-token': 'jeton-de-test-moderation' },
  });
  const body = await res.json();
  assert(res.ok && body.moderated === true, 'suppression par le modérateur');
  assert((await fetch(`${base}/api/transfers/${second.id}`)).status === 404,
    'le transfert signalé a bien disparu');
};
