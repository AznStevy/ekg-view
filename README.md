# EKG View

Interactive 3D cardiac conduction system with a live, time-synced **12-lead EKG** (Three.js).

Pick classic findings (NSR, blocks, bundle branch block, AFib/flutter, VT, WPW, STEMI, and more). As the strip advances, matching pathways light up on the heart, and the cycle bar (P · PR · QRS · ST · T · TP) highlights the active ECG segment.

## Local

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Output is in `dist/`.

## Deploy (GitHub Pages)

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. Push to `main` (or re-run the **Deploy** workflow under the Actions tab).

Site URL: `https://<user>.github.io/ekg-view/`

The deploy workflow runs `npm run mirror:physio` before the build so curated PhysioNet records (mitdb, afdb, …) ship as static `wfdb/` assets. That avoids browser CORS limits on physionet.org — **search + load of those teaching sets works on the live Pages site**. Local `npm run dev` still uses the Vite `/physionet` proxy for live PhysioNet access.

## Controls

- **Orbit** the 3D view (drag) · scroll to zoom
- **Findings** panel: select a rhythm / block pattern
- **Rate**: set ventricular rate (bpm)
- **Vectors** (`V`): mean P/QRS/T vectors
- **Field** (`F`): myocardial vector field; AV fibrous plane is an insulator (His is the only bridge)
- **Leads** (`L`): RA/LA/LL/RL + V1–V6 electrode positions in space
- Traveling white impulse moves down the conduction pathways with the cycle
- **EKG scrub**: drag or scroll the 12-lead to move in time (auto-pauses)
- **Upload EKG**: PNG/JPG strip → extracted tracing drives the heart
- **Playback**: play/pause, reset (`Space` / `R`)
- **Heart**: toggle translucent heart shell
- Hover pathways for labels
