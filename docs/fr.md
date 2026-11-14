# Azure Speech

Donne à Gladys les voix neuronales de **Microsoft Azure Speech** pour ses annonces (l’action de scène « Jouer
une notification ») et la réponse de l’assistant vocal, avec **la clé de votre propre ressource Speech**.
Non officielle : sans lien avec Microsoft.

Cette intégration n’a encore jamais été testée avec un vrai compte Azure : elle a été écrite d’après la
documentation de l’API REST d’Azure Speech et testée contre une imitation locale de cette API.

## Ce qu’elle fait

Gladys envoie un texte (2 000 caractères au plus) et la langue de l’utilisateur. L’intégration choisit la voix
que vous avez retenue pour cette langue (français, anglais ou allemand ; sinon la voix « Langue si inconnue »),
demande à Azure Speech un clip MP3 (24 kHz, 48 kbit/s) et le remet à Gladys, qui le joue sur vos enceintes.

Ensuite, dans Gladys, ouvrez **Intégrations → Intelligence artificielle**, carte **Voix**, et choisissez
**Azure Speech**.

Limites de Gladys elle-même (pas de cette intégration) : le clip est servi aux enceintes de votre réseau local,
et la réponse de l’assistant vocal reste en texte dans une page HTTPS (voir la documentation de Gladys).

## Ce que ça coûte

Azure Speech est facturé au caractère envoyé, sur votre abonnement Azure (tarifs sur
[azure.microsoft.com](https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/), novembre 2026) : le **palier gratuit (F0)** d’une ressource Speech donne 500 000 caractères de voix neuronales par mois ;
au palier payant (S0), les voix neuronales standard coûtent environ 15 USD le million de caractères. Seules les
voix neuronales standard sont proposées ici : les voix HD coûtent plus cher.

Pour garder la facture sous contrôle :

- **Limite mensuelle** (500 000 caractères par défaut, le palier gratuit) : comptée en mémoire avant le départ de
  chaque requête, et écrite dans `/data` (écriture attendue 1 s au plus) ; une fois atteinte, plus rien n’est
  envoyé avant le mois civil suivant (UTC) ou une limite plus haute. L’intégration compte ce qu’Azure facture : chaque
  caractère de la requête, balise de débit comprise (environ 32 caractères par annonce quand le débit n’est pas
  « Normal »), `&`, `<` et `>` sous leur forme d’entité XML (5 ou 4 caractères), et un caractère chinois deux fois.
  Le palier gratuit suit le mois Azure de la ressource : gardez une marge. Une requête peut-être facturée (pas de réponse, connexion coupée, clip inutilisable) reste comptée ;
  une requête à laquelle Azure a répondu par un code d’erreur ne l’est pas. Une annonce n’est jamais bloquée par
  `/data` (retardée de 3 s au plus) : s’il n’est pas encore lu (2 s au plus), en lecture seule ou lent, la
  requête part quand même et le statut dit « le compteur mensuel n’est pas enregistré : le plafond n’est garanti
  que jusqu’au prochain redémarrage » (la pause et un refus qui y sont gardés peuvent aussi être inconnus). Une
  coupure de courant ou un plantage au mauvais moment peut perdre le compte d’une requête.
- Le même texte dans la même voix est rejoué depuis la mémoire (24 heures, 20 clips), sans être facturé deux
  fois ; demandé plusieurs fois au même moment (une scène qui annonce sur plusieurs enceintes), il ne fait
  qu’une requête dont tous partagent la réponse.
- Au plus 2 requêtes à la fois et 8 en attente ; au-delà, au même moment, elles sont refusées (« Trop
  d’annonces à la fois »).
- Aucune nouvelle tentative : une requête en échec n’est pas renvoyée par l’intégration (elle pourrait être
  facturée deux fois).
- Le palier gratuit n’accepte aussi que 20 requêtes par 60 secondes : au-delà, Azure répond HTTP 429 et
  l’intégration met toutes les annonces en pause 60 s (plus longtemps si cela continue, voir plus bas).
- Avec le palier gratuit, Azure s’arrête de lui-même à son quota (l’intégration montre alors l’erreur d’Azure).
  Avec S0, rien ne s’arrête côté Azure : réglez aussi une **alerte de budget** dans Azure Cost Management.

## Créer la ressource Speech

1. Dans le [portail Azure](https://portal.azure.com), **Créer une ressource → Speech** (ou « Service Speech »).
2. Choisissez une région (par exemple West Europe) et le niveau tarifaire **Free F0**, ou Standard S0.
3. Une fois créée, ouvrez **Clés et point de terminaison** : copiez **KEY 1** (ou KEY 2) et notez la
   **Location/Region** (`westeurope`, `francecentral`…).

## Configuration

| Champ                                 | Rôle                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Clé de la ressource                   | Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à Azure Speech (dans l’en-tête `Ocp-Apim-Subscription-Key`). |
| Région de la ressource                | La région affichée à côté de la clé (`westeurope` par défaut). Une clé ne marche que dans sa région.                              |
| Voix française / anglaise / allemande | La voix de chaque langue (voix neuronales standard ; les « multilingues » lisent aussi d’autres langues).                         |
| Langue si inconnue                    | La voix utilisée quand Gladys n’envoie pas de langue, ou une autre.                                                               |
| Débit de parole                       | De très lent à très rapide (`prosody` SSML).                                                                                      |
| Limite mensuelle (caractères)         | De 1 000 à 100 000 000 ; 500 000 par défaut.                                                                                      |

Le bouton **Tester la voix** demande à Azure une courte phrase (environ 50 caractères facturés, environ 80 avec un débit autre que « Normal ») avec les
réglages enregistrés et dit combien de temps cela a pris. Rien n’est joué.

## En cas de problème

Le statut de l’écran Configuration dit pourquoi :

- **Azure a refusé cette clé** (HTTP 401 : clé erronée ou régénérée, ou clé d’une ressource d’une autre
  région) : plus rien n’est envoyé avec elle dans cette région, même après un redémarrage (une fois `/data` lu),
  tant que vous ne saisissez pas une autre clé, ne choisissez pas une autre région, ou que le bouton **Tester**
  ne réussit pas (il envoie quand même). `/data` ne garde que 8 bits d’une empreinte salée de la clé et de la
  région refusées, jamais la clé : après un redémarrage, une autre clé a 1 chance sur 256 de paraître refusée ;
  le bouton Tester lève alors le doute.
- **Azure a refusé la synthèse** (HTTP 403) : par exemple le quota du palier gratuit est épuisé, ou les règles
  réseau de la ressource bloquent l’adresse de Gladys. Ce n’est pas un refus de la clé : l’annonce suivante
  réessaie.
- **Ralentir / Azure en échec** (HTTP 429 ou 5xx) : aucune requête pendant 60 s, puis 2, 4… minutes jusqu’à
  1 heure si cela continue (plus longtemps quand Azure le demande par `Retry-After`, 6 heures au plus) ; le
  bouton Tester attend aussi. La pause est gardée dans `/data` d’un redémarrage à l’autre ; un succès y met fin.
- **Azure a refusé la requête** (HTTP 400 ou autre 4xx) : le plus souvent une voix que la région ne propose
  pas ; seul le code est affiché (le corps de la réponse pourrait citer votre texte) ; rien n’est facturé.
- **Injoignable, ou connexion coupée** : une coupure après le départ de la requête reste comptée.
- **Pas de réponse à temps** : Gladys attend 30 s ; l’intégration abandonne à 25 s.

## Vie privée

Le texte à dire est envoyé à Microsoft Azure, dans la région de votre ressource. L’intégration ne l’écrit
jamais dans les journaux ni dans `/data` (seulement sa longueur) ; les clips restent en mémoire seulement. Une
redirection depuis l’adresse d’Azure n’est jamais suivie : la clé ne part nulle part ailleurs.
