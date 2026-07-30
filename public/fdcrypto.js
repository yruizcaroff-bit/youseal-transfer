'use strict';

/**
 * Chiffrement de bout en bout — AES-256-GCM (WebCrypto).
 *
 * La cle est generee dans le navigateur de l'expediteur et transmise
 * uniquement dans le fragment de l'URL (#...), que les navigateurs n'envoient
 * jamais au serveur. Le serveur ne stocke que du chiffre.
 *
 * Chaque fichier est decoupe en blocs de 4 Mio chiffres independamment :
 *
 *   bloc = IV (12 o) || chiffre(texte clair) || tag GCM (16 o)
 *
 * L'index du bloc et l'identifiant du fichier sont passes en donnees
 * authentifiees (AAD) : un bloc ne peut etre ni deplace, ni reutilise dans un
 * autre fichier sans faire echouer le dechiffrement.
 *
 * Ce fichier est charge tel quel par la page, par le Service Worker
 * (importScripts) et par les tests Node.
 */

const FD_CHUNK = 4 * 1024 * 1024; // taille d'un bloc en clair, par defaut
const FD_IV_LEN = 12;
const FD_TAG_LEN = 16;
const FD_OVERHEAD = FD_IV_LEN + FD_TAG_LEN; // 28 octets ajoutes par bloc

// Bornes de la taille de bloc adaptative. En dessous, les allers-retours
// dominent ; au-dessus, une coupure fait perdre trop de travail et la memoire
// du navigateur souffre.
const FD_CHUNK_MIN = 512 * 1024;
const FD_CHUNK_MAX = 16 * 1024 * 1024;

/**
 * La taille de bloc est choisie par l'expediteur puis inscrite dans le
 * manifeste : le destinataire doit retrouver exactement le meme decoupage.
 * Toutes les fonctions ci-dessous l'acceptent en dernier argument et
 * retombent sur la valeur par defaut, ce qui preserve les anciens transferts.
 */
function fdChunk(chunk) {
  const value = Number(chunk);
  return Number.isFinite(value) && value >= FD_CHUNK_MIN && value <= FD_CHUNK_MAX
    ? value
    : FD_CHUNK;
}

/** Nombre de blocs pour un fichier de `size` octets (un fichier vide en a un). */
function fdChunkCount(size, chunk) {
  return Math.max(1, Math.ceil(size / fdChunk(chunk)));
}

/** Taille en clair du bloc numero `index`. */
function fdChunkSize(size, index, chunk) {
  const c = fdChunk(chunk);
  return Math.min(c, Math.max(0, size - index * c));
}

/** Taille totale du fichier une fois chiffre. */
function fdEncryptedSize(size, chunk) {
  return size + FD_OVERHEAD * fdChunkCount(size, chunk);
}

/** Position, dans le fichier chiffre, du debut du bloc `index`. */
function fdEncryptedOffset(size, index, chunk) {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += FD_OVERHEAD + fdChunkSize(size, i, chunk);
  return offset;
}

/** Dernier bloc entierement recu a partir du nombre d'octets chiffres presents. */
function fdChunkAtOffset(size, encryptedOffset, chunk) {
  let offset = 0;
  for (let i = 0; i < fdChunkCount(size, chunk); i++) {
    const next = offset + FD_OVERHEAD + fdChunkSize(size, i, chunk);
    if (next > encryptedOffset) return { index: i, offset };
    offset = next;
  }
  return { index: fdChunkCount(size, chunk), offset };
}

// --- base64url ---------------------------------------------------------------

function fdToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fdFromBase64Url(text) {
  const base64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- cles --------------------------------------------------------------------

function fdGenerateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function fdExportKey(key) {
  return fdToBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

function fdImportKey(text) {
  const raw = fdFromBase64Url(text);
  if (raw.length !== 32) return Promise.reject(new Error('Cle invalide.'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

// --- compression (facultative) -----------------------------------------------

/*
 * Compresser avant de chiffrer, jamais l'inverse : du chiffre est
 * indistinguable de l'aleatoire et ne se compresse pas.
 *
 * Le gain porte sur le reseau, seul goulot reel du service. Il est nul, voire
 * negatif, sur les formats deja compresses — d'ou la liste ci-dessous.
 *
 * Contrepartie assumee : le taux de compression obtenu renseigne indirectement
 * sur la nature du contenu. C'est pourquoi l'option reste au choix de
 * l'expediteur plutot qu'activee d'office.
 */
const FD_DEJA_COMPRESSE =
  /\.(jpe?g|png|gif|webp|avif|heic|heif|mp4|m4v|mkv|avi|mov|webm|wmv|mp3|m4a|aac|ogg|opus|flac|wma|zip|rar|7z|gz|tgz|xz|bz2|zst|br|lz4|pdf|docx|xlsx|pptx|odt|ods|odp|epub|apk|jar|woff2?|dmg|iso)$/i;

/** Un fichier merite-t-il d'etre compresse ? */
function fdCompressible(name, type = '') {
  if (FD_DEJA_COMPRESSE.test(String(name))) return false;
  // Les types image/, video/ et audio/ sont compresses sauf exception rare.
  if (/^(image|video|audio)\//i.test(type) && !/svg|bmp|wav|aiff?/i.test(type)) return false;
  return typeof CompressionStream === 'function';
}

/** Compresse un Blob et renvoie les octets obtenus. */
async function fdCompress(blob) {
  const flux = blob.stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

/** Remet un flux compresse dans son etat d'origine. */
function fdDecompressStream(readable) {
  return readable.pipeThrough(new DecompressionStream('deflate-raw'));
}

// --- empreinte de la cle -----------------------------------------------------

/**
 * Six caracteres derives de l'empreinte SHA-256 de la cle.
 *
 * Affichee des deux cotes, elle permet de verifier de vive voix que le lien
 * recu est bien celui qui a ete envoye : un lien altere en chemin donnerait une
 * empreinte differente. L'alphabet exclut 0, O, 1 et I, indistinguables aussi
 * bien a l'oral qu'a l'ecran.
 */
const FD_FINGERPRINT_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

async function fdFingerprint(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  let out = '';
  // 256 est un multiple exact de 32 : le modulo ne biaise pas la repartition.
  for (let i = 0; i < 6; i++) out += FD_FINGERPRINT_ALPHABET[digest[i] % 32];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

// --- blocs -------------------------------------------------------------------

function fdAad(fileId, index) {
  return new TextEncoder().encode(`${fileId}:${index}`);
}

/** Chiffre un bloc en clair -> IV || chiffre || tag. */
async function fdEncryptChunk(key, fileId, index, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(FD_IV_LEN));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: fdAad(fileId, index), tagLength: 128 },
    key,
    plain
  ));
  const block = new Uint8Array(FD_IV_LEN + sealed.length);
  block.set(iv, 0);
  block.set(sealed, FD_IV_LEN);
  return block;
}

/** Dechiffre un bloc complet (IV || chiffre || tag). Leve si altere. */
async function fdDecryptChunk(key, fileId, index, block) {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: block.subarray(0, FD_IV_LEN),
      additionalData: fdAad(fileId, index),
      tagLength: 128,
    },
    key,
    block.subarray(FD_IV_LEN)
  );
  return new Uint8Array(plain);
}

// --- manifeste (noms des fichiers + message) ---------------------------------

async function fdEncryptManifest(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(FD_IV_LEN));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: fdAad('manifest', 0), tagLength: 128 },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  ));
  const out = new Uint8Array(FD_IV_LEN + sealed.length);
  out.set(iv, 0);
  out.set(sealed, FD_IV_LEN);
  return fdToBase64Url(out);
}

async function fdDecryptManifest(key, text) {
  const bytes = fdFromBase64Url(text);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.subarray(0, FD_IV_LEN),
      additionalData: fdAad('manifest', 0),
      tagLength: 128,
    },
    key,
    bytes.subarray(FD_IV_LEN)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// --- flux --------------------------------------------------------------------

function fdConcat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Dechiffre un flux d'octets chiffres, bloc par bloc.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<Uint8Array>} texte clair
 */
async function* fdDecryptStream(key, fileId, size, body, chunk) {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let ended = false;
  const total = fdChunkCount(size, chunk);

  for (let index = 0; index < total; index++) {
    const needed = FD_OVERHEAD + fdChunkSize(size, index, chunk);
    while (buffer.length < needed) {
      if (ended) throw new Error('Flux chiffre incomplet.');
      const { value, done } = await reader.read();
      if (done) { ended = true; continue; }
      buffer = fdConcat(buffer, value);
    }
    const block = buffer.slice(0, needed);
    buffer = buffer.slice(needed);
    yield await fdDecryptChunk(key, fileId, index, block);
  }
}

/** Transforme un iterateur asynchrone en ReadableStream (avec contre-pression). */
function fdStreamFrom(iterator) {
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      if (iterator.return) iterator.return(reason);
    },
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FD_CHUNK, FD_CHUNK_MIN, FD_CHUNK_MAX, FD_IV_LEN, FD_TAG_LEN, FD_OVERHEAD,
    fdChunk, fdCompressible, fdCompress, fdDecompressStream,
    fdChunkCount, fdChunkSize, fdEncryptedSize, fdEncryptedOffset, fdChunkAtOffset,
    fdToBase64Url, fdFromBase64Url,
    fdGenerateKey, fdExportKey, fdImportKey,
    fdEncryptChunk, fdDecryptChunk, fdFingerprint,
    fdEncryptManifest, fdDecryptManifest,
    fdDecryptStream, fdStreamFrom, fdConcat,
  };
}
