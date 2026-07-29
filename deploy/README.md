# Héberger YouSeal sur cette machine (Windows)

Tout est installé dans `D:\YouSeal` : le code, le dépôt git et les transferts
(`D:\YouSeal\storage`). Rien n'est écrit sur `C:`.

## Ce qui est déjà en place

| Élément | État |
| --- | --- |
| Service Node | tâche planifiée **YouSeal**, démarrage à l'ouverture de session |
| Écoute | `127.0.0.1:3000` — accessible uniquement depuis cette machine |
| Stockage | `D:\YouSeal\storage`, quota de 30 Go |
| Jeton de modération | généré dans `deploy\env.cmd` (non versionné) |

Commandes utiles :

```powershell
Start-ScheduledTask -TaskName YouSeal
```

```powershell
Stop-ScheduledTask -TaskName YouSeal ; Get-Process node | Stop-Process -Force
```

Pour lancer à la main, en voyant les journaux : `deploy\start.cmd`.

## En ligne sur https://youseal.site

Le site est exposé **sans ouvrir le moindre port** : `cloudflared` établit une
connexion sortante vers Cloudflare, qui lui achemine les visiteurs et fournit le
certificat HTTPS. L'adresse IP du domicile n'est jamais exposée.

| Élément | Valeur |
| --- | --- |
| Tunnel | `youseal`, identifiant `ac9a7d1b-e6a8-4666-a38d-6ff1b4f03651` |
| Configuration | `deploy\tunnel-config.yml` |
| Domaines desservis | `youseal.site` et `www.youseal.site` |
| Tâche **YouSeal** | le service Node, démarre à l'ouverture de session |
| Tâche **YouSeal-Tunnel** | le tunnel, démarre à l'ouverture de session |

Trois fichiers de `deploy\` sont **secrets** et exclus du dépôt :
`cert.pem`, `tunnel-credentials.json` et `env.cmd`. Perdre les deux premiers
oblige à recréer le tunnel ; les diffuser permettrait à un tiers de détourner le
trafic du domaine.

Vérifier l'état du tunnel :

```powershell
Get-Content D:\YouSeal\deploy\tunnel.log -Tail 20
```

Limite à connaître : les conditions du plan gratuit de Cloudflare voient d'un
mauvais œil la distribution massive de gros fichiers. Pour un usage personnel,
aucun problème.

## Rendre le site accessible depuis Internet (redirection de ports)

Quatre étapes, dans cet ordre. **Le HTTPS n'est pas optionnel** : sans lui, le
navigateur désactive WebCrypto et le Service Worker, et l'application ne
fonctionne pas du tout.

### 1. Vérifier que la connexion est joignable

Comparer l'adresse IP publique affichée dans l'interface de la box avec celle
que renvoie un service « quelle est mon IP ». Si elles diffèrent, ou si celle de
la box commence par `100.64` à `100.127`, la connexion est derrière un CGNAT :
la redirection de ports ne fonctionnera pas, il faut passer par un tunnel.

### 2. Rediriger les ports 80 et 443

Dans l'interface de la box, vers l'adresse IP locale de cette machine. Fixer
cette adresse (bail DHCP statique), sinon la redirection cassera au prochain
redémarrage.

### 3. Faire pointer le domaine

Chez Namecheap, onglet **Advanced DNS** du domaine : deux enregistrements `A`,
`@` et `www`, vers l'IP publique.

Une connexion résidentielle change d'IP : activer **Dynamic DNS** sur la même
page, coller le mot de passe fourni dans `deploy\ddns-password.txt`, puis
planifier la mise à jour toutes les dix minutes :

```powershell
Register-ScheduledTask -TaskName "YouSeal-DDNS" -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -WindowStyle Hidden -File "D:\YouSeal\deploy\ddns-namecheap.ps1"') -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)) -Force
```

### 4. Mettre Caddy devant

Caddy obtient et renouvelle seul le certificat Let's Encrypt. Le fichier
`deploy\Caddyfile` est prêt : il ajoute les en-têtes de sécurité, ne limite pas
la taille des requêtes et ne met pas les flux en tampon — indispensable pour les
blocs de 4 Mio et pour les statistiques en direct.

Télécharger `caddy_windows_amd64.exe` depuis <https://caddyserver.com/download>,
le placer dans `D:\YouSeal\deploy\`, puis :

```powershell
D:\YouSeal\deploy\caddy.exe run --config D:\YouSeal\deploy\Caddyfile
```

Ne lancer Caddy qu'une fois le domaine résolu et les ports ouverts : sinon la
validation échoue et Let's Encrypt impose une attente avant de réessayer.

Enfin, décommenter dans `deploy\env.cmd` :

```
set "TRUST_PROXY=1"
set "PUBLIC_URL=https://youseal.site"
```

`TRUST_PROXY=1` ne doit être activé **que** derrière Caddy : sans proxy, un
visiteur pourrait usurper son adresse via `X-Forwarded-For` et contourner les
limites par adresse.

## Modération

Supprimer un transfert signalé, sans détenir le jeton de l'expéditeur (le jeton
se trouve dans `deploy\env.cmd`) :

```powershell
Invoke-RestMethod -Method Delete -Uri "https://youseal.site/api/transfers/<identifiant>" -Headers @{ 'x-admin-token' = '<jeton>' }
```

L'identifiant est la partie de l'adresse située entre `/t/` et le `#`.

## Points de vigilance propres à l'auto-hébergement

- **Mise en veille = service coupé.** À désactiver dans les paramètres
  d'alimentation, sinon les liens partagés cessent de fonctionner.
- **Chaque téléchargement consomme le débit montant** de la connexion, partagé
  avec tout le foyer.
- **La machine est exposée** et se trouve sur le même réseau local que le reste
  des appareils. Un tunnel (Cloudflare) évite d'ouvrir des ports et masque
  l'adresse personnelle.
- **Ne pas supprimer `storage\.secret`** : les liens protégés par mot de passe
  cesseraient d'être déverrouillables.

## La déclaration de transparence

`public/transparence.html` contient une déclaration datée : à ce jour, aucune
réquisition judiciaire reçue. **Elle se met à jour à la main**, environ une fois
par mois, en changeant simplement la date.

Ne l'automatisez jamais. Tout son intérêt tient à ce que son absence de mise à
jour fasse signal : si la date cesse d'avancer, le lecteur en tire ses propres
conclusions. Une date rafraîchie par un script ne dirait plus rien.

Si vous ne souhaitez pas porter cet engagement, supprimez le paragraphe plutôt
que de le laisser vieillir.

## Purge en cas de saturation

Passé **750 Go** occupés, les transferts les plus anciens sont effacés jusqu'à en
libérer **50**, même s'ils n'ont pas expiré. Sans ce mécanisme, le service
refuserait tout nouvel envoi une fois les 800 Go atteints, jusqu'à ce que les
transferts expirent d'eux-mêmes.

Réglable par `PRUNE_THRESHOLD` et `PRUNE_AMOUNT` dans `deploy\start.cmd`. Mettre
l'un des deux à zéro désactive la purge.

Chaque passage écrit dans le journal le nombre de transferts effacés et le volume
libéré. L'ancienneté se compte à la date de dépôt : un transfert récent mais
volumineux survivra à un ancien plus petit.

**Cette suppression est annoncée** à l'article 5 des conditions d'utilisation.
Si vous relevez le seuil ou désactivez la purge, la mention peut rester ; si vous
la supprimez du code, retirez aussi le paragraphe.
