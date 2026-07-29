# YouSeal

Application de transfert de fichiers : on dépose des fichiers, on récupère
un lien unique à partager. **Chiffré de bout en bout** : les fichiers sont scellés dans le
navigateur, le serveur ne peut lire ni leur contenu, ni leurs noms. Le transfert s'auto-détruit
à l'expiration.

**Node.js pur, zéro dépendance** — aucun `npm install` nécessaire.

## Démarrage

```bash
node server.js
```

Puis ouvrir http://localhost:3000

## Fonctionnalités

- Glisser-déposer multi-fichiers, avec barre de progression par fichier et progression globale
- **Chiffrement de bout en bout** AES-256-GCM, clé jamais transmise au serveur (voir plus bas)
- **Reprise automatique** : une coupure réseau relance l'envoi au dernier bloc complet
- Lien de partage unique, expiration configurable (1 à 30 jours)
- Mot de passe facultatif (scrypt + sel), limite de téléchargements facultative
- Message d'accompagnement, lui aussi chiffré
- Téléchargement fichier par fichier ou **tout en ZIP** (généré en flux, ZIP64 pour les gros volumes)
- Suppression manuelle du transfert par l'expéditeur, purge automatique des transferts expirés
- Pages **Soutien**, **Statistiques** (compteurs en direct), **Conditions d'utilisation** et **Contact**

## Statistiques en direct

`/statistiques` affiche des compteurs poussés par le serveur en Server-Sent Events : la page se
met à jour au moment où un transfert est scellé ou téléchargé, sans interrogation répétée.

- Cumuls persistés dans `storage/stats.json` : transferts, fichiers, volume, téléchargements
- Jauges « en ce moment » : transferts en ligne, fichiers, volume stocké, connexions ouvertes ;
  recalculées au démarrage et après chaque purge
- Uniquement des totaux agrégés : aucune adresse IP, aucun journal de connexion, et aucun nom
  de fichier — le chiffrement les rend de toute façon illisibles pour le serveur

`/soutien` énonce les engagements du service — gratuit, sans publicité, sans traqueur, sans
fonctionnalité payante — et propose de le partager (copie du lien, e-mail, partage natif du
système). Aucun script tiers, aucun bouton de réseau social : l'adresse partagée est lue depuis
`location.origin`, donc le lien reste juste quel que soit l'hébergement.

Les pages `/conditions` et `/contact` sont rédigées et renseignées (adresses `@youseal.site`,
droit français, expiration maximale de 30 jours). Deux réserves avant une ouverture au public :
les adresses e-mail doivent exister réellement, et la LCEN impose des mentions légales
identifiant l'éditeur (nom, contact) et l'hébergeur — à ajouter à l'article 1.

## Chiffrement de bout en bout

Le navigateur de l'expéditeur génère une clé AES-256-GCM et la place **dans le fragment de
l'URL** (`/t/<id>#<clé>`). Les navigateurs n'envoient jamais un fragment au serveur : celui-ci
ne reçoit donc que des octets illisibles, et le lien complet est le seul moyen de les relire.

- Chaque fichier est découpé en blocs de 4 Mio chiffrés séparément :
  `IV (12 o) || chiffré || tag GCM (16 o)`. L'identifiant du fichier et l'index du bloc sont
  passés en données authentifiées : un bloc ne peut être ni déplacé, ni réutilisé ailleurs.
- Les **noms de fichiers, types et message** vivent dans un manifeste chiffré à part. Côté
  serveur, les fichiers s'appellent `chiffre-1.bin`, `chiffre-2.bin`…
- Toute altération du contenu stocké fait échouer le déchiffrement (tag GCM).
- Le déchiffrement se fait **en flux** dans un Service Worker : un fichier de plusieurs Go ne
  passe jamais entièrement en mémoire. Sans Service Worker (contexte non sécurisé), la page
  bascule sur un déchiffrement en mémoire, avec avertissement au-delà de 1 Go.
- L'archive ZIP est fabriquée **par le navigateur** ; le serveur en est incapable et répond
  `409` sur la route correspondante pour un transfert chiffré.

Conséquences à assumer :

- **Lien perdu = fichiers perdus.** Aucune récupération n'est possible, y compris par
  l'administrateur du serveur.
- Le lien doit être partagé **entier**. Tronqué après le `#`, il est inutilisable.
- Le lien est le secret : qui l'obtient obtient les fichiers. Le mot de passe optionnel
  ajoute une barrière côté serveur, mais ne remplace pas la confidentialité du lien.
- L'envoi exige un **contexte sécurisé** (HTTPS ou `localhost`) : WebCrypto n'est pas
  disponible autrement.

## Configuration

Tout se règle par variables d'environnement (valeurs par défaut entre parenthèses) :

| Variable | Rôle |
| --- | --- |
| `PORT` | port d'écoute (`3000`) |
| `HOST` | interface d'écoute (`0.0.0.0`) |
| `STORAGE_DIR` | dossier de stockage (`./storage`) |
| `MAX_FILE_SIZE` | taille max par fichier, en octets (5 Go) |
| `MAX_TRANSFER_SIZE` | taille max par transfert, en octets (10 Go) |
| `MAX_FILES` | nombre max de fichiers par transfert (`200`) |
| `DEFAULT_EXPIRY_DAYS` / `MAX_EXPIRY_DAYS` | expiration par défaut (`7`) et plafond (`30`) |
| `ACCESS_TOKEN_TTL_MS` | validité d'un déverrouillage par mot de passe (6 h) |
| `PUBLIC_URL` | URL publique utilisée dans les liens (sinon déduite de l'en-tête `Host`) |
| `CLEANUP_INTERVAL_MS` | fréquence de purge des transferts expirés (1 h) |
| `MAX_STORAGE` | capacité totale du service, en octets (50 Go) |
| `RATE_CREATE_PER_HOUR` | transferts créés par adresse et par heure (`20`) |
| `RATE_AUTH_PER_15MIN` | tentatives de mot de passe par adresse (`20` / 15 min) |
| `MAX_STREAM_CLIENTS` / `MAX_STREAM_PER_IP` | connexions au flux de statistiques (`200` / `4`) |
| `TRUST_PROXY` | `1` derrière un reverse proxy de confiance, pour lire `X-Forwarded-For` |

Exemple :

```bash
PORT=8080 MAX_TRANSFER_SIZE=2147483648 PUBLIC_URL=https://envoi.mondomaine.fr node server.js
```

## Organisation

```
server.js               serveur HTTP + routes
lib/config.js           configuration (variables d'environnement)
lib/store.js            stockage disque, mots de passe, jetons, purge
lib/stats.js            compteurs d'utilisation + diffusion temps réel (SSE)
lib/limits.js           limitation par adresse et quota de stockage
public/history.js       « Mes transferts » (mémoire locale du navigateur)
public/soutien.js       partage du site (copie, e-mail, partage natif)
lib/zip.js              ZIP en streaming côté serveur (transferts non chiffrés)
public/fdcrypto.js      chiffrement AES-256-GCM (page, Service Worker et tests)
public/zipstream.js     ZIP en streaming côté navigateur
public/sw.js            Service Worker : déchiffrement en flux vers le disque
public/app.js           page d'envoi
public/transfer.js      page de réception
scripts/cleanup.js      purge manuelle : node scripts/cleanup.js
storage/                transferts (créé au démarrage, à ne pas versionner)
```

Chaque transfert est un dossier `storage/<id>/` contenant `meta.json` et `files/<fileId>`.
Les fichiers sur disque portent des identifiants aléatoires, jamais un nom fourni par
l'utilisateur — et pour un transfert chiffré, `meta.json` ne contient aucune métadonnée
lisible hormis les tailles chiffrées et les dates.

## API

| Méthode | Route | Description |
| --- | --- | --- |
| `POST` | `/api/transfers` | crée le transfert (`encrypted` + `manifest`), renvoie `id` + `ownerToken` |
| `PUT` | `/api/transfers/:id/files/:fileId` | envoie le contenu ; `x-upload-offset` reprend, et tronque si le décalage est antérieur |
| `GET` | `/api/transfers/:id/files/:fileId/status` | octets déjà reçus (expéditeur) |
| `POST` | `/api/transfers/:id/complete` | finalise et renvoie le lien de partage |
| `GET` | `/api/transfers/:id` | métadonnées publiques |
| `POST` | `/api/transfers/:id/auth` | échange le mot de passe contre un jeton d'accès |
| `GET` | `/api/transfers/:id/files/:fileId/download` | télécharge un fichier (supporte `Range`) |
| `GET` | `/api/transfers/:id/download` | ZIP de l'ensemble — `409` si le transfert est chiffré |
| `DELETE` | `/api/transfers/:id` | supprime le transfert (`x-owner-token` requis) |
| `GET` | `/api/stats` | instantané des compteurs (JSON) |
| `GET` | `/api/stats/stream` | flux Server-Sent Events des compteurs |

Les opérations d'expéditeur exigent l'en-tête `x-owner-token`. Pour un transfert protégé,
les téléchargements exigent `?k=<jeton>` obtenu via `/auth`.

## À prévoir avant une mise en ligne publique

- **HTTPS obligatoire** (reverse proxy nginx/Caddy) : sans contexte sécurisé, WebCrypto et le
  Service Worker sont indisponibles, donc l'envoi est bloqué. En local, `localhost` suffit.
- `TRUST_PROXY=1` **uniquement** derrière un reverse proxy de confiance. Sans proxy, laissez-le
  désactivé : n'importe quel client pourrait sinon usurper son adresse via `X-Forwarded-For`
  et contourner les limites.
- Le chiffrement protège le contenu, pas la métadonnée résiduelle : le serveur connaît le
  nombre de fichiers, leurs tailles (à 28 octets par bloc près) et les dates.
