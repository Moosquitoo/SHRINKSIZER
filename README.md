# SHRINKSIZER

**Vos vidéos, au poids que vous voulez.**

SHRINKSIZER compresse des vidéos directement dans le navigateur. Vous indiquez une taille maximale (par exemple 25 Mo pour un e-mail), et l'appli calcule le réglage qui garde la meilleure image possible pour la tenir. Aucun fichier n'est envoyé sur un serveur : tout se passe sur votre appareil.

*English: browser-only video compressor. Set a target file size and SHRINKSIZER picks the bitrate, resolution and frame rate that give the best quality under that size. Nothing is uploaded.*

## Fonctionnalités

- **Taille cible en Mo** : le débit est calculé à partir de la durée, de la place prise par le son et par le conteneur MP4. Si le résultat dépasse la cible, une nouvelle passe plus légère est lancée ; s'il reste beaucoup de marge, une passe de meilleure qualité est tentée. On garde toujours le meilleur fichier qui tient sous la cible.
- **Choix automatique de la résolution** : si le budget est trop serré pour garder la 4K ou le 1080p sans artefacts, la vidéo est réduite (et passée de 60 à 30 i/s si besoin), ce qui donne une image bien plus nette qu'une pleine résolution trop compressée.
- **Mode qualité** : un curseur, sans contrainte de taille.
- **Préréglages** : WhatsApp 16 Mo, Discord 20 Mo, e-mail 25 Mo…
- **Formats de sortie** : H.264 (lu partout), H.265 et AV1 (plus légers) quand le navigateur sait les encoder.
- **Comparaison avant / après** avec un rideau à faire glisser sur l'image.
- **Plusieurs fichiers** à la suite, glisser-déposer, sans limite de taille.
- Thème clair et sombre automatiques, utilisable sur mobile.

## Comment ça marche

| Moteur | Utilisé pour | Vitesse |
| --- | --- | --- |
| [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) via [Mediabunny](https://mediabunny.dev) | MP4, MOV, WebM, MKV, MPEG-TS | Rapide, accéléré par la carte graphique |
| [ffmpeg.wasm](https://ffmpegwasm.netlify.app) | AVI, MPEG, WMV, FLV et tout ce que le navigateur ne lit pas | Plus lent, téléchargé (~32 Mo) seulement si besoin |

Le choix du moteur est automatique. Le calcul de la taille cible est dans [`js/planner.js`](js/planner.js) (module sans dépendance, testable avec Node).

## Mettre en ligne sur GitHub Pages

1. Créez un dépôt (par exemple `shrinksizer`) et poussez-y le contenu de ce dossier :
   ```bash
   git init
   git add .
   git commit -m "SHRINKSIZER"
   git branch -M main
   git remote add origin https://github.com/VOTRE-PSEUDO/shrinksizer.git
   git push -u origin main
   ```
2. Sur GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. Après une minute, l'appli est en ligne sur `https://VOTRE-PSEUDO.github.io/shrinksizer/`. Le lien « Code source » du pied de page pointe tout seul vers votre dépôt.

Aucune étape de compilation : ce sont des fichiers statiques.

### Tester en local

Les modules JavaScript ne fonctionnent pas en ouvrant `index.html` directement (`file://`). Lancez un petit serveur :

```bash
python3 -m http.server 8080
# puis ouvrez http://localhost:8080
```

### Fonctionnement 100 % hors ligne (optionnel)

Par défaut, le cœur de ffmpeg.wasm est chargé depuis jsDelivr la première fois qu'un format ancien est déposé. Pour l'héberger vous-même, copiez `ffmpeg-core.js` et `ffmpeg-core.wasm` (paquet npm `@ffmpeg/core@0.12.10`, dossier `dist/esm`) dans `vendor/ffmpeg-core/`. L'appli les utilisera en priorité.

```bash
npm pack @ffmpeg/core@0.12.10 && tar -xzf ffmpeg-core-0.12.10.tgz
mkdir -p vendor/ffmpeg-core && cp package/dist/esm/* vendor/ffmpeg-core/ && rm -rf package ffmpeg-core-0.12.10.tgz
```

## Navigateurs

Chrome, Edge, Opera, Firefox et Safari récents gèrent WebCodecs. Les encodeurs disponibles (H.265, AV1) dépendent du navigateur et du matériel : l'appli les détecte et repasse en H.264 si besoin. Sans WebCodecs, tout passe par ffmpeg.wasm.

## Structure

```
index.html            page unique
css/style.css         styles (thème clair / sombre)
js/app.js             interface : file d'attente, réglages, comparaison
js/engine.js          compression WebCodecs (Mediabunny) et passes successives
js/ffmpeg-engine.js   moteur de secours ffmpeg.wasm
js/planner.js         calcul du débit, de la résolution et des i/s pour une taille cible
vendor/               bibliothèques tierces (aucun build nécessaire)
```

## Licences

Le code de SHRINKSIZER est sous licence MIT (voir `LICENSE`).

Bibliothèques incluses dans `vendor/` :
- [Mediabunny](https://github.com/Vanilagy/mediabunny) et `@mediabunny/aac-encoder` : MPL-2.0
- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/ffmpeg`, `@ffmpeg/util`) : MIT
- Le cœur `@ffmpeg/core`, chargé à la demande, est sous GPL-2.0-or-later. Si vous le copiez dans `vendor/ffmpeg-core/`, la licence GPL s'applique à cette copie.

Projet indépendant, sans lien avec VideoSmaller ou FileConverto.
