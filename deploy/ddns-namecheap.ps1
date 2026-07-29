# Met à jour l'enregistrement A de youseal.site chez Namecheap.
#
# Une connexion résidentielle change d'adresse IP sans prévenir : sans cette
# mise à jour, le domaine finit par pointer vers le vide.
#
# Préalable : dans Namecheap, onglet « Advanced DNS » du domaine, activer
# « Dynamic DNS » et copier le mot de passe fourni dans :
#     D:\YouSeal\deploy\ddns-password.txt
#
# À planifier toutes les 10 minutes (voir deploy/install-taches.ps1).

$ErrorActionPreference = 'Stop'

$domain = 'youseal.site'
$hosts = @('@', 'www')

$passwordFile = Join-Path $PSScriptRoot 'ddns-password.txt'
if (-not (Test-Path $passwordFile)) {
    Write-Error "Mot de passe absent : $passwordFile"
}
$password = (Get-Content $passwordFile -Raw).Trim()

$logFile = Join-Path $PSScriptRoot 'ddns.log'
function Write-Log($message) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" | Add-Content -Path $logFile -Encoding utf8
}

foreach ($name in $hosts) {
    $url = "https://dynamicdns.park-your-domain.com/update?host=$name&domain=$domain&password=$password"
    try {
        # Sans paramètre ip, Namecheap retient l'adresse source de la requête.
        $response = Invoke-RestMethod -Uri $url -TimeoutSec 30
        $errors = $response.'interface-response'.ErrCount
        if ($errors -eq '0') {
            $ip = $response.'interface-response'.IP
            Write-Log "$name.$domain -> $ip"
        } else {
            Write-Log "$name.$domain : echec ($($response.'interface-response'.errors.Err1))"
        }
    } catch {
        Write-Log "$name.$domain : $($_.Exception.Message)"
    }
}
