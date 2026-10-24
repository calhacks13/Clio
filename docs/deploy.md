# Testing on the Quest from one HTTPS link

WebXR and the headset camera only work in a secure context, so Quest Browser has to load Clio over
HTTPS, or from `http://localhost` over `adb reverse` (the cable path in
[dev-setup.md](dev-setup.md)). This page covers the cable-free path: a public HTTPS link that you
open on the headset.

Once the headset app is built, the server serves all of Clio from one origin: the app at `/`, the
API at `/api` and the Gemini Live relay at `/gemini`. So any HTTPS front works: a tunnel to the
laptop, or a cloud host. There is no CORS to deal with, and the headset app runs unchanged. An
access key keeps strangers out.

| Option                              | Link                                                       | Where it runs                                              |
| ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| **A. `pnpm live`** (recommended)    | `https://<random>.trycloudflare.com/?key=…`, new every run | your laptop: episodes and the Gemini key stay on it        |
| B. Render, from the `deploy` branch | `https://<service>.onrender.com/?key=…`, stable            | Render's free tier: sleeps when idle, and forgets episodes |
| C. Any Docker host                  | yours                                                      | yours                                                      |

## Option A: `pnpm live` (recommended)

No accounts. You need cloudflared (Cloudflare's tunnel client) and the usual setup: `pnpm install`,
plus `GEMINI_API_KEY` in `.env` if you want the voice coach.

```bash
brew install cloudflared      # once
pnpm live                     # or: pnpm live --port 8790
```

It does four things:
1. Builds the headset app (`pnpm build`).
2. Starts the server on `127.0.0.1` with an access key. It reuses `CLIO_ACCESS_KEY` from the
   environment or `.env`; otherwise it makes a new random key for this run.
3. Opens a Cloudflare quick tunnel to the server, which needs no login:
   `cloudflared tunnel --url http://127.0.0.1:<port>`.
4. Prints the link to open on the headset, and a link that sends it to the headset from your phone:

```
  On the Quest, open this in Quest Browser:

    https://brave-otter-sails-quietly.trycloudflare.com/?key=Xq3v9TbR0kLm2PzA
```

Ctrl-C stops the server and the tunnel (press it again to stop waiting for them). Good to know:
- **The link changes on every run.** Open the new one, with its `?key=`, each time.
- **Episodes are saved on the laptop** (`data/`), as with `pnpm dev`. The Gemini key never leaves
  the laptop either: the relay adds it on the server.
- **The laptop must stay awake and online.** Quick tunnels have no uptime guarantee, and they take
  at most 200 requests at a time.
- **`pnpm dev` can keep running** on its own port. If `pnpm live` finds a server already on the
  port, it stops rather than publish it; use `--port`. If you keep `CLIO_ACCESS_KEY` in `.env`,
  the Vite dev proxy sends it for you.

**If the tunnel doesn't connect.** cloudflared reaches Cloudflare over outbound port 7844. Some
campus and guest networks block it. UC Berkeley's network did when this was tested (October 24,
2026), and `pnpm live` then says "This network blocks Cloudflare Tunnel". Put the laptop on a phone
hotspot and run it again. The Quest can stay on the venue Wi-Fi: trycloudflare.com links load fine
there, because they use port 443. The tunnel uses HTTP/2 over TCP, since guest Wi-Fi often drops
QUIC (UDP); set `TUNNEL_TRANSPORT_PROTOCOL=quic` to try QUIC instead. Option B doesn't depend on the
laptop's network at all.

## Option B: Render, from the `deploy` branch

This gives you a stable link that works without the laptop. [`render.yaml`](../render.yaml)
describes one free web service. Render builds it from the [`Dockerfile`](../Dockerfile) on the
`deploy` branch and redeploys it on every push to that branch.

One-time setup:
1. In the [Render dashboard](https://dashboard.render.com), choose **New → Blueprint**, connect
   GitHub, and pick `calhacks13/Clio`. The repo is private, so Render's GitHub app needs access to
   it (an owner of the `calhacks13` organization may have to approve that). Link the **`deploy`**
   branch: `render.yaml` is only on that branch.
2. Render asks for `GEMINI_API_KEY`, once. Paste it, then choose **Deploy Blueprint**.
3. When the service is live, open it, go to **Environment**, and copy `CLIO_ACCESS_KEY`. Render
   generated it: 44 base64 characters, which work typed as is (`+`, `/` and `=` included). You can
   replace it with a shorter key of your own.
4. Open `https://<service>.onrender.com/?key=<CLIO_ACCESS_KEY>` on the Quest.

Know the free tier's limits:
- **It sleeps.** After 15 minutes without traffic, the service spins down. The next visit waits
  about a minute while it wakes. An open coach session counts as traffic.
- **Its disk is ephemeral.** Episodes, generated plans and clips are lost on every restart, sleep
  and deploy, and every push to `deploy` is a deploy. Record sessions you want to keep with
  Option A, or download them first, for example:
  `curl -H "Authorization: Bearer $KEY" https://<service>.onrender.com/api/episodes`.

## Option C: any Docker host

```bash
docker build -t clio .
docker run --rm -p 8787:8787 -v clio-data:/app/data \
  -e GEMINI_API_KEY=… -e CLIO_ACCESS_KEY="$(openssl rand -hex 12)" clio
```

The container listens on `0.0.0.0:8787`, or on `$PORT` if the host sets one, and speaks plain HTTP.
Put HTTPS in front of it: the host's own TLS, a reverse proxy, or
`cloudflared tunnel --url http://localhost:8787`. Mount `/app/data` to keep episodes, and set
`CLIO_ACCESS_KEY` whenever the URL is public.

## On the Quest

**Opening the link.** Pick one:
- Type it into Quest Browser. With `pnpm live` the key part is 16 characters.
- Send it from your phone or laptop. `pnpm live` also prints a
  `https://www.oculus.com/open_url/?url=…` link (Meta's
  [Web Launch](https://developers.meta.com/horizon/documentation/web/web-launch/)). Open it in a
  browser that is signed in to the headset's Meta account (the one in the Meta Horizon app), and
  the link opens in Quest Browser on the headset. For Option B, build the same link by
  URL-encoding yours after `?url=`.
- On USB with adb set up ([dev-setup.md](dev-setup.md)):
  `adb shell "am start -a android.intent.action.VIEW -d '<link>'"`.

**The access key.** The first visit with `?key=` stores the key in a cookie for 30 days, then
reloads the page without it, so the key doesn't stay in the address bar. After that, the plain URL
works on that headset. Each `pnpm live` run is a new site, though, so open each run's link with its
`?key=`. Without the key, the launcher says **"no access key: open the link with ?key=…"**. Tools
can send `Authorization: Bearer <key>` instead of the cookie.

**Camera and microphone.** Permissions are per site, so each new tunnel link asks again. Allow both
on the launcher before you press **Enter AR**: a prompt inside the immersive session ends it. On
Quest Browser 150–154, the headset-camera prompt may never appear. Grant it once over adb (see the
[camera permission workaround](dev-setup.md#camera-permission-workaround)). That grant belongs to
the browser app, so it covers every link. Without a camera, `?camera=0` still works: you register
objects by pinching.

## Security notes

- **The key is a shared password, and it's in the link.** Anyone with the link can use the app,
  spend your Gemini quota, and read the episodes on that server. Share it only with your team, and
  keep it out of screenshots and public chats. The tunnel provider sees the link, and so does Meta
  if you use Web Launch.
- **Without `CLIO_ACCESS_KEY`, the API is open.** Never put a server on a public URL without it.
  `pnpm live` always sets one, and `render.yaml` generates one.
- **What the key protects:** every `/api` route except `GET /api/health`, and the `/gemini` relay
  (a WebSocket without it is refused with 401). **What stays public:** the app's static files,
  which hold no secrets, and `/api/health` (the version, the live model, and whether a Gemini key
  is set), for platform health checks.
- **The cookie** is HttpOnly, so page scripts can't read it. It's SameSite=Lax, so other sites
  can't make the browser send it with their requests. It's Secure behind HTTPS, and it lasts 30
  days. The server compares keys in constant time. There is no rate limiting.
- **The Gemini key stays on the server** (the laptop, or Render). The relay adds it, and the
  headset only ever sees a placeholder.
- **`pnpm live` keeps the server on loopback.** The only way in is the tunnel.
- **To rotate the key:** `pnpm live` without `CLIO_ACCESS_KEY` makes a new one every run. On Render,
  change `CLIO_ACCESS_KEY` under **Environment**. Old links and cookies then stop working.
- `.env` is gitignored and dockerignored. Keep keys out of commits.

## Updating the branch

`deploy` is `main` plus these deployment pieces. To pick up new work from `main`:

```bash
git checkout deploy && git merge main && git push
```

Render redeploys on every push to `deploy`, which also wipes its disk. `pnpm live` always builds
whatever you have checked out.

## Troubleshooting

| You see                                     | Do this                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `cloudflared is not installed`              | `brew install cloudflared`                                                     |
| `Port 8787 is in use`                       | stop `pnpm dev`, or `pnpm live --port 8790`                                    |
| `This network blocks Cloudflare Tunnel`     | put the laptop on a phone hotspot (see Option A), or use Option B              |
| "no access key: open the link with ?key=…"  | open the link that has `?key=` in it                                           |
| "server unreachable" on the headset         | the laptop, tunnel or server stopped: run `pnpm live` again, open the new link |
| Render: the first visit hangs for a minute  | it was asleep; wait                                                            |
| No camera prompt, or only the avatar camera | the [adb grant](dev-setup.md#camera-permission-workaround)                     |
