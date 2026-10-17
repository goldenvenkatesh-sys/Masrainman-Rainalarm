# MasRainman Rain Alarm

A phone web app that warns you before rain reaches your place — Tamil + English.

* **Rain-alarm style map** — smooth rain plot in mm/h colours (0.2 … 420 mm/h scale bar), terrain basemap, radar range rings, cyan time box with play / alarm on-off / step back / back-to-now
* **Live radar loop** — past 2 hours of IMD Doppler radar + the next 90-minute nowcast, play/pause and a time slider (forecast frames get a yellow frame)
* **RainViewer** layer (past 2 h) for areas outside IMD radar
* **My places** — home, office, family town, or GPS; each card has a 60-minute rain strip
* **Alarm** — sound, vibration and a phone notification when rain is due within 30 / 60 / 90 min or is falling now; choose any rain / moderate+ / heavy only; quiet hours 11 PM – 6 AM
* Outside IMD coverage the alarm uses RainViewer motion, then the Open-Meteo 15-minute model
* Installs to the home screen like an app (PWA), works on Android and iPhone

This is a **separate project** from the radar bot. It only *reads* the public radar repo
[`goldenvenkatesh-sys/masrainman-nowcast`](https://github.com/goldenvenkatesh-sys/masrainman-nowcast);
nothing is written back there, so the Telegram / Facebook / WhatsApp posting keeps running untouched.

```
masrainman-nowcast (radar bot, unchanged)          masrainman-rain-alarm (this repo)
  nowcast_bot.py  ─────── read-only checkout ──►   scripts/cycle.py  (every 10 min, GitHub Actions)
  masrainman/places.py                                  │ runs the engine in a throw-away copy
  assets/boundaries.json                                ▼
                                                   docs/data/  nowcast + 2 h history
                                                        │
                                                   docs/  (the app, GitHub Pages)  ──►  phones
```

## Files

| Path | What it does |
|---|---|
| `docs/index.html`, `app.js`, `app.css` | The app: map, radar loop, places, alarm, settings |
| `docs/engine.js` | Reads the radar grid and decides the alarm (shared with the service worker) |
| `docs/sw.js` | Works offline; background checks on Android when installed |
| `docs/manifest.webmanifest`, `docs/icons/` | Home-screen app name and icons |
| `docs/data/` | Radar data, written by the workflow every 10 min (do not edit) |
| `scripts/cycle.py` | Runs the radar engine and exports `docs/data/` |
| `scripts/make_demo_nowcast.py` | Fake storm data for testing without radar |
| `.github/workflows/rain-alarm.yml` | The 10-minute schedule |

## Setup (about 10 minutes)

1. Create a new **public** GitHub repo named `masrainman-rain-alarm` (public = free Actions minutes and free Pages).
2. Upload everything in this folder (including the hidden `.github` folder and `docs/.nojekyll`) to the `main` branch.
3. **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**
4. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch `main`, folder `/docs` → Save.**
5. **Actions → MasRainman Rain Alarm data → Run workflow** once. After it finishes (and a minute for Pages), open
   `https://goldenvenkatesh-sys.github.io/masrainman-rain-alarm/`
6. On the phone: open the link in Chrome → ⋮ → **Add to Home screen**. On iPhone: Safari → Share → **Add to Home Screen**.

Optional: to read a different radar repo, set the repository variable `RADAR_REPO` (e.g. `you/your-radar-repo`).

## Good to know

* Alarms ring instantly while the app is open (screen on, or in the background for a while). Fully closed, Android Chrome
  may still wake the installed app for checks, but the phone decides how often, so it is not guaranteed.
* The nowcast moves the current rain along its measured track; storms can grow or die, so arrival times are a guide.
* RainViewer's free service gives only the past 2 hours and is for personal and educational use.
* The map stops at 24.5° N (the radars are all in South India), so no basemap border north of that is shown.
* Each visitor's places and settings stay in their own phone's browser.

## Test without radar

```
python scripts/make_demo_nowcast.py
python -m http.server -d docs
```
then open http://localhost:8000 — a demo storm moves towards Chennai and Tambaram.
