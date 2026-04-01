# Discord Music Bot

Bot de Discord para reproducir musica desde YouTube y Spotify usando slash commands.

## Comandos

| Comando | Descripcion |
| --- | --- |
| `/play [cancion o URL]` | Reproduce o encola una cancion |
| `/skip` | Salta la cancion actual |
| `/pause` | Pausa la reproduccion |
| `/resume` | Reanuda la reproduccion |
| `/stop` | Detiene la reproduccion y limpia la cola |
| `/queue` | Muestra la cola actual |
| `/volume [0-100]` | Ajusta el volumen |
| `/loop` | Activa o desactiva el bucle de la cola |
| `/join` | Une al bot a tu canal de voz |
| `/leave` | Desconecta al bot |

## Requisitos

- Node.js 22.12.0 o superior
- Un bot de Discord con permisos `Connect`, `Speak`, `Send Messages` y `Use Application Commands`
- `DISCORD_TOKEN`
- `SPOTIFY_CLIENT_ID` y `SPOTIFY_CLIENT_SECRET` solo si usaras enlaces de Spotify

## Instalacion

```bash
npm install
copy .env.example .env
```

Completa el archivo `.env`:

```env
DISCORD_TOKEN=tu_token_de_discord
SPOTIFY_CLIENT_ID=opcional
SPOTIFY_CLIENT_SECRET=opcional
YOUTUBE_COOKIES=opcional_json_de_cookies
```

Si YouTube bloquea la reproduccion con mensajes como `Sign in to confirm you’re not a bot`, configura `YOUTUBE_COOKIES` con cookies exportadas de una cuenta secundaria de YouTube en formato JSON.

## Uso

```bash
npm run check
npm start
```

Cuando el bot arranque, registrara los slash commands automaticamente.

## Deploy en Railway

Railway debe usar Node 22.12.0 o superior. Si tu servicio quedo creado con Node 18, actualiza la version en la configuracion del proyecto o vuelve a desplegar despues de subir estos archivos.

Si Railway sigue tomando una version vieja, confirma que:

- el repo remoto tenga el cambio en `package.json`
- exista `.nvmrc` en la raiz
- no tengas fijada manualmente una version anterior de Node en variables o settings del servicio

## Publicar en GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

`.gitignore` ya excluye `node_modules` y archivos con secretos.

## Notas

- Si no configuras Spotify, el bot seguira funcionando con YouTube.
- `ffmpeg-static` ya viene como dependencia, asi que no necesitas instalar FFmpeg manualmente para este proyecto.
