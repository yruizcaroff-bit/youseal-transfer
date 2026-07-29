# YouSeal

Transfert de fichiers chiffré de bout en bout, **sans aucune dépendance**.

On dépose des fichiers, on récupère un lien. Le chiffrement a lieu dans le
navigateur et la clé ne quitte jamais l'appareil : le serveur ne peut lire ni le
contenu des fichiers, ni leurs noms, ni le message qui les accompagne.

🔗 **[youseal.site](https://youseal.site)** — instance publique

```bash
node server.js
```

Aucun `npm install`. Node 18 ou plus, et c'est tout : ni framework, ni base de
données, ni bibliothèque de chiffrement, ni générateur d'archives.

---

## Comment le chiffrement fonctionne

Le navigateur de l'expéditeur tire une clé AES-256-GCM et la place **dans le
fragment de l'URL** — la partie après le `#`, que les navigateurs n'envoient
jamais au serveur.

```
https://youseal.site/t/7cb62b77ffab8b469874#uB7rjO7Ht8uLk1VQVJWgfXpClc741NR
                       └── identifiant ──┘ └───── clé, jamais transmise ────┘
```

Chaque fichier est découpé en blocs de 4 Mio chiffrés séparément :

```
bloc = IV (12 o) ‖ chiffré ‖ tag GCM (16 o)
```

L'identifiant du fichier et l'index du bloc sont passés en **données
authentifiées**. Un bloc ne peut donc être ni réordonné, ni recyclé dans un autre
fichier : le déchiffrement échouerait.

Les **noms de fichiers, types et message** vivent dans un manifeste chiffré à
part. Côté serveur, les fichiers s'appellent `chiffre-1.bin`, `chiffre-2.bin`…

Conséquence assumée : **un lien perdu, ce sont des fichiers perdus.** Personne ne
peut les récupérer, pas même l'exploitant du serveur.

## Ce que le projet contient

Tout est écrit à la main, y compris ce qu'on importe d'ordinaire :

| Fichier | Rôle |
| --- | --- |
| `lib/zip.js` | archive ZIP64 en flux, côté serveur |
| `public/zipstream.js` | la même, côté navigateur — indispensable puisque le serveur ne peut pas lire les fichiers |
| `public/qr.js` | encodeur de QR code : Reed-Solomon sur GF(256), codes BCH, choix du masque |
| `public/fdcrypto.js` | chiffrement par blocs, partagé par la page, le Service Worker et les tests |
| `public/sw.js` | Service Worker qui déchiffre en flux vers le disque, sans passer par la mémoire |
| `lib/pairing.js` | échange de clés ECDH entre deux appareils |

## Fonctionnalités

- **Envoi par blocs avec reprise** après coupure réseau, au dernier bloc complet
- **Déchiffrement en flux** par Service Worker : un fichier de plusieurs Go ne
  passe jamais entièrement en mémoire
- **Archive ZIP fabriquée par le navigateur**, le serveur en étant incapable
- **Code court à six caractères** pour ouvrir un transfert sur un autre appareil,
  par échange de clés ECDH : le serveur voit passer deux clés publiques et un
  paquet qu'il ne peut pas ouvrir
- **Empreinte de la clé** affichée des deux côtés, à comparer de vive voix
- **QR code** du lien de partage
- **Destruction après téléchargement**, expiration de 1 à 30 jours, mot de passe
  facultatif, limite de téléchargements
- **Liste « Mes transferts »** dans le navigateur, pour supprimer ses envois plus tard
- **Statistiques d'utilisation en direct** poussées en Server-Sent Events
- **Limitation par adresse**, quota de stockage, purge des plus anciens à
  saturation, jeton de modération pour traiter un signalement

## Démarrage

```bash
git clone https://github.com/yruizcaroff-bit/youseal-transfer.git
```

```bash
cd youseal-transfer && node server.js
```

Puis <http://localhost:3000>.

> **Le HTTPS n'est pas optionnel en production.** Sans contexte sécurisé, les
> navigateurs désactivent WebCrypto et les Service Workers : l'application ne
> fonctionne pas du tout. En local, `localhost` fait exception.

## Configuration

Tout passe par des variables d'environnement.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `PORT` / `HOST` | écoute | `3000` / `0.0.0.0` |
| `STORAGE_DIR` | dossier des transferts | `./storage` |
| `PUBLIC_URL` | adresse publique, pour construire les liens | déduite de `Host` |
| `MAX_FILE_SIZE` / `MAX_TRANSFER_SIZE` | tailles maximales | 5 Go / 10 Go |
| `MAX_STORAGE` | capacité totale | 50 Go |
| `PRUNE_THRESHOLD` / `PRUNE_AMOUNT` | purge des plus anciens à saturation | désactivée |
| `DEFAULT_EXPIRY_DAYS` / `MAX_EXPIRY_DAYS` | expiration | 7 / 30 |
| `RATE_CREATE_PER_HOUR` | transferts créés par adresse | 20 |
| `RATE_AUTH_PER_15MIN` | tentatives de mot de passe par adresse | 20 |
| `ADMIN_TOKEN` | jeton de modération ; vide = modération désactivée | vide |
| `TRUST_PROXY` | `1` **uniquement** derrière un proxy de confiance | désactivé |

`TRUST_PROXY` activé sans proxy devant permettrait à n'importe qui d'usurper son
adresse via `X-Forwarded-For` et de contourner toutes les limites.

Le dossier [`deploy/`](deploy/) contient une configuration Caddy, une
configuration de tunnel Cloudflare et un guide d'installation sous Windows.

## Tests

```bash
npm test
```

Le lanceur démarre lui-même les serveurs dont il a besoin, sur un port et un
stockage temporaires. **133 vérifications** : chiffrement de bout en bout,
restitution à l'identique, détection d'altération, reprise d'envoi, archives ZIP,
QR code confronté aux tables de la norme, appairage, limites, purge, modération.

## API

| Méthode | Route | Description |
| --- | --- | --- |
| `POST` | `/api/transfers` | crée le transfert, renvoie `id` + `ownerToken` |
| `PUT` | `/api/transfers/:id/files/:fileId` | envoie un bloc ; `x-upload-offset` reprend |
| `POST` | `/api/transfers/:id/complete` | finalise et renvoie le lien |
| `GET` | `/api/transfers/:id` | métadonnées publiques, manifeste chiffré compris |
| `GET` | `/api/transfers/:id/files/:fileId/download` | télécharge un fichier (supporte `Range`) |
| `DELETE` | `/api/transfers/:id` | supprime (`x-owner-token` ou `x-admin-token`) |
| `POST` | `/api/pairings` | ouvre un rendez-vous et renvoie un code à six caractères |
| `GET` | `/api/stats/stream` | flux Server-Sent Events des compteurs |

## Limites connues

- **Pas d'audit externe.** Les primitives viennent de WebCrypto, mais leur
  assemblage — découpage en blocs, manifeste, appairage — est fait maison et n'a
  été relu par personne d'autre que son auteur.
- **Le serveur sert le code qui chiffre.** C'est la faiblesse commune à tous les
  services de chiffrement dans le navigateur : un serveur compromis pourrait
  livrer une version modifiée. Comparer le code servi à ce dépôt est le seul
  recours, et il repose sur la vigilance de l'utilisateur.
- **Un seul processus.** Compteurs, verrous et appairages vivent en mémoire :
  plusieurs instances derrière un répartiteur de charge exigeraient un stockage
  partagé.
- **Pas de reprise au téléchargement.** Une coupure oblige à reprendre le fichier
  depuis le début, alors que l'envoi, lui, reprend au dernier bloc.

## Licence

MIT — voir [LICENSE](LICENSE).
