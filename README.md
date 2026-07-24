# EKG View

Interactive 3D cardiac conduction system with a live, time-synced **12-lead EKG** (Three.js).

Created by **Stevy**, an internal medicine resident who likes EKGs and cardiology.

Pick classic findings (NSR, blocks, bundle branch block, AFib/flutter, VT, WPW, STEMI, and more). As the strip advances, matching pathways light up on the heart, and the cycle bar (P · PR · QRS · ST · T · TP) highlights the active ECG segment.

**Live site:** [https://aznstevy.github.io/ekg-view/](https://aznstevy.github.io/ekg-view/)

## Disclaimer

This is an **educational tool** only. It is not medical advice, not a diagnostic device, and not a substitute for clinical judgment, formal ECG training, or patient care. Tracings are simplified teaching models and may not match real patient ECGs. The author assumes **no liability** for any decisions, outcomes, or damages arising from use of this tool.

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
