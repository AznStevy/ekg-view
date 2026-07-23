import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createActivationVectors } from "./activationVectors";
import {
  createConductionSystem,
  SEGMENT_META,
  type ConductionSystem,
} from "./conductionAnatomy";
import { createEkgTrace } from "./ekgTrace";
import { createLeadPositions } from "./leadPositions";
import {
  layoutLabel,
  parseEkgFile,
  suggestFindingFromUpload,
  type UploadedEkg,
} from "./ekgUpload";
import {
  curatedDbMatches,
  loadPhysioNetRecord,
  searchCuratedRecords,
  searchPhysioNetProjects,
  type PhysioRecordRef,
} from "./physionet";
import {
  FINDINGS,
  cycleSecForRate,
  findingMatchesQuery,
  getFinding,
  type FindingId,
  type SegmentId,
} from "./findings";
import {
  branchesFromStim,
  sampleStim,
  stimDetail,
  stimLabel,
  type StimSite,
  type StimState,
} from "./stimPace";
import { createDeviceLeads, deviceModeForFinding } from "./deviceLeads";
import { blockSiteForFinding, branchesFromBundleBlocks } from "./pathwayTiming";
import {
  BUNDLE_BLOCK_OPTIONS,
  blocksForFinding,
  describeBundleBlocks,
  findingIdForBlocks,
  lesionSegmentsForBlocks,
  sampleFromBundleBlocks,
  type BundleBlockId,
} from "./branchBlock";

const BBB_FINDING_IDS = new Set<FindingId>([
  "rbbb",
  "lbbb",
  "lafb",
  "lpfb",
  "rbbbLafb",
  "rbbbLpfb",
]);

type AppState = {
  finding: FindingId;
  playing: boolean;
  ventRateBpm: number;
  /** Multiplier on animation time (independent of physiologic HR) */
  playbackSpeed: number;
  elapsed: number;
  heartVisible: boolean;
  vectorsOn: boolean;
  fieldOn: boolean;
  leadsOn: boolean;
  /** Custom His–Purkinje lesions (empty = use finding defaults) */
  customBlocks: BundleBlockId[];
  /** True when user is driving EKG from customBlocks rather than a preset finding */
  customBlockMode: boolean;
  upload: UploadedEkg | null;
  stim: StimState;
};

function buildUI(root: HTMLElement): {
  ekgHost: HTMLElement;
  els: Record<string, HTMLElement>;
} {
  const segmentToggles = SEGMENT_META.filter((s) => s.id !== "myocardiumA" && s.id !== "myocardiumV")
    .map(
      (g) => `
      <label class="vessel-toggle">
        <input type="checkbox" data-segment="${g.id}" ${g.defaultOn ? "checked" : ""} />
        <span class="swatch" style="background:${g.color}"></span>
        <span>${g.label}</span>
      </label>`,
    )
    .join("");

  const bbbGroupButton = `<button type="button" id="btn-bbb" data-bbb-group title="Bundle branch / fascicular blocks">
      BBB<small>RBB · LBB · fascicles</small>
    </button>`;

  const bbbOptionsHtml = `
            <div class="bbb-options" id="bbb-options" aria-hidden="true">
              <div class="bbb-options-inner">
                <div class="bbb-options-panel">
                  <div class="bbb-options-head">
                    <span>Block which pathway?</span>
                    <button type="button" id="btn-block-clear" class="bbb-options-clear">Clear</button>
                  </div>
                  <div class="bbb-lesion-grid" id="branch-block-grid">
                    ${BUNDLE_BLOCK_OPTIONS.map(
                      (o) => `<label class="bbb-lesion-chip">
                        <input type="checkbox" data-bundle-block="${o.id}" />
                        <span class="bbb-lesion-short">${o.short}</span>
                        <span class="bbb-lesion-name">${o.label}</span>
                      </label>`,
                    ).join("")}
                  </div>
                  <div class="bbb-result" id="bbb-result">Select one or more tracts</div>
                </div>
              </div>
            </div>`;

  const findingButtonHtml: string[] = [];
  let bbbInserted = false;
  for (const f of FINDINGS) {
    if (f.category === "bbb") {
      if (!bbbInserted) {
        findingButtonHtml.push(bbbGroupButton);
        findingButtonHtml.push(bbbOptionsHtml);
        bbbInserted = true;
      }
      continue;
    }
    findingButtonHtml.push(`
    <button type="button" data-finding="${f.id}" title="${f.name}" ${f.id === "nsr" ? 'class="active"' : ""}>
      ${f.short}<small>${f.rateLabel}</small>
    </button>`);
  }
  if (!bbbInserted) {
    findingButtonHtml.push(bbbGroupButton);
    findingButtonHtml.push(bbbOptionsHtml);
  }
  const findingButtons = findingButtonHtml.join("");

  root.innerHTML = `
    <div id="stage">
      <section class="view-pane" id="view-3d" aria-label="3D conduction system">
        <div id="viewport"></div>
        <div class="pane-chrome">
          <span class="phase-chip" id="phase-chip">—</span>
          <button type="button" class="view-reset" id="btn-view-reset" title="Reset 3D camera to default view">
            Reset view
          </button>
        </div>
      </section>
      <div id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panes" tabindex="0"></div>
      <section class="view-pane" id="view-ekg" aria-label="Live EKG tracing">
        <div class="ekg-header">
          <h2>12-lead · scrub to explore</h2>
          <div class="ekg-meta">
            <span class="meta-pill" id="meta-finding">NSR</span>
            <span class="meta-pill" id="meta-rate">70 bpm</span>
          </div>
        </div>
        <div class="ekg-body" id="ekg-host"></div>
        <div class="ekg-footer" id="ekg-footer">
          Drag / swipe the EKG to scrub · playing auto-pauses while scrubbing.
        </div>
      </section>
    </div>

    <div class="hud">
      <header class="brand">
        <h1>EKG View</h1>
      </header>

      <div class="panel-shell" id="panel-shell">
        <aside class="panel" id="panel" aria-label="Controls">
          <div class="panel-top">
            <h2>Findings</h2>
            <button type="button" class="panel-collapse" id="btn-collapse" title="Hide panel" aria-label="Hide panel">
              <span class="collapse-chevron collapse-chevron--side" aria-hidden="true">‹</span>
              <svg class="collapse-chevron collapse-chevron--down" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.2 4.2 L6 8 L9.8 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>

          <div class="finding-readout">
            <div class="label">Selected</div>
            <div class="value" id="finding-name">Normal sinus rhythm</div>
            <div class="detail" id="finding-detail">SA → AV → His → bundles → Purkinje</div>
          </div>

          <div class="transport">
            <h3>Playback</h3>
            <div class="transport-row">
              <button type="button" id="btn-play" class="active">Pause</button>
              <button type="button" id="btn-reset">Reset</button>
              <button type="button" id="btn-heart">Heart</button>
            </div>
            <div class="transport-row">
              <button type="button" id="btn-vectors">Vectors</button>
              <button type="button" id="btn-field">Field</button>
              <button type="button" id="btn-leads">Leads</button>
            </div>
            <div class="transport-row">
              <button type="button" id="btn-stim" title="Click a pathway to pace from that site">Stimulate</button>
              <button type="button" id="btn-stim-clear" title="Clear stimulated pace site">Clear stim</button>
              <button type="button" id="btn-cv" title="Synchronized cardioversion → NSR">Cardiovert</button>
            </div>
            <p class="stim-hint" id="stim-hint" hidden>Click a conduction pathway on the heart to pace from that site.</p>
            <div class="slider-row rate-row">
              <label for="rate-input">Rate</label>
              <input id="rate-slider" type="range" min="30" max="200" value="70" step="1" />
              <div class="num-wrap">
                <input id="rate-input" type="number" min="30" max="200" step="1" value="70" aria-label="Ventricular rate" />
                <span class="unit">bpm</span>
              </div>
            </div>
            <div class="slider-row speed-row">
              <label for="speed-input">Speed</label>
              <input id="speed-slider" type="range" min="25" max="200" value="100" step="5" />
              <div class="num-wrap">
                <input id="speed-input" type="number" min="25" max="200" step="5" value="100" aria-label="Depolarization animation speed" />
                <span class="unit">%</span>
              </div>
            </div>
          </div>

          <div class="upload-block">
            <h3>Upload EKG</h3>
            <p class="upload-hint">
              Image strip / 12-lead, CSV, JSON, or HL7 aECG XML. Telemetry and partial leads resize the display.
            </p>
            <label class="upload-btn" for="ekg-file">Choose file</label>
            <input
              id="ekg-file"
              type="file"
              accept="image/*,.csv,.txt,.json,.xml,text/csv,application/json,text/xml,application/xml"
              hidden
            />
            <div class="upload-preview" id="upload-preview" hidden>
              <img id="upload-thumb" alt="Uploaded EKG preview" />
              <div class="upload-meta" id="upload-meta"></div>
              <button type="button" id="btn-clear-upload" class="upload-clear">Clear upload</button>
            </div>
          </div>

          <div class="presets">
            <h3>EKG findings</h3>
            <input
              id="finding-search"
              type="search"
              placeholder="Findings or PhysioNet: mitdb, afdb, 100…"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search EKG findings and PhysioNet records"
            />
            <div class="finding-empty" id="finding-empty" hidden>No matching findings</div>
            <div class="preset-grid" id="finding-grid">
              ${findingButtons}
            </div>
            <div class="physionet-block" id="physionet-block" hidden>
              <h3>PhysioNet</h3>
              <p class="physionet-examples">
                Examples:
                <code>mitdb</code>
                <code>mitdb/100</code>
                <code>afdb</code>
                <code>nsrdb</code>
                <code>vfdb</code>
                <code>svdb</code>
                <code>afib</code>
                <code>arrhythmia</code>
              </p>
              <p class="physionet-hint" id="physionet-hint">Click a record to load ~12s into the EKG pane</p>
              <div class="physionet-results" id="physionet-results"></div>
            </div>
          </div>

          <div class="legend">
            <h3>Pathways</h3>
            <div class="vessel-actions">
              <button type="button" id="btn-seg-all">All</button>
              <button type="button" id="btn-seg-none">None</button>
            </div>
            <div class="vessel-toggles" id="segment-toggles">
              ${segmentToggles}
            </div>
          </div>
        </aside>
        <button type="button" class="panel-expand" id="btn-expand" title="Show panel" aria-label="Show panel">Panel</button>
      </div>

      <div id="seg-tooltip" class="seg-tooltip" hidden>
        <div class="seg-tooltip-group"></div>
        <div class="seg-tooltip-name"></div>
        <div class="seg-tooltip-detail"></div>
      </div>
    </div>
  `;

  const ekgHost = root.querySelector("#ekg-host") as HTMLElement;

  const ids = [
    "phase-chip",
    "meta-finding",
    "meta-rate",
    "ekg-footer",
    "panel-shell",
    "btn-collapse",
    "btn-expand",
    "finding-name",
    "finding-detail",
    "btn-play",
    "btn-reset",
    "btn-view-reset",
    "btn-heart",
    "btn-vectors",
    "btn-field",
    "btn-leads",
    "btn-stim",
    "btn-stim-clear",
    "btn-cv",
    "stim-hint",
    "rate-slider",
    "rate-input",
    "speed-slider",
    "speed-input",
    "branch-block-grid",
    "btn-block-clear",
    "btn-bbb",
    "bbb-options",
    "bbb-result",
    "finding-grid",
    "finding-search",
    "finding-empty",
    "physionet-block",
    "physionet-hint",
    "physionet-results",
    "btn-seg-all",
    "btn-seg-none",
    "segment-toggles",
    "seg-tooltip",
    "viewport",
    "ekg-file",
    "upload-preview",
    "upload-thumb",
    "upload-meta",
    "btn-clear-upload",
  ] as const;

  const els: Record<string, HTMLElement> = {};
  for (const id of ids) {
    els[id] = root.querySelector(`#${id}`) as HTMLElement;
  }

  return { ekgHost, els };
}

function main() {
  const app = document.querySelector("#app");
  if (!app) throw new Error("#app missing");

  const { ekgHost, els } = buildUI(app as HTMLElement);
  const canvasHost = els["viewport"];

  const state: AppState = {
    finding: "nsr",
    playing: true,
    ventRateBpm: 70,
    playbackSpeed: 1,
    elapsed: 0,
    heartVisible: true,
    vectorsOn: false,
    fieldOn: false,
    leadsOn: false,
    customBlocks: [],
    customBlockMode: false,
    upload: null,
    stim: { armed: false, site: null },
  };

  const segmentVisibility: Record<SegmentId, boolean> = Object.fromEntries(
    SEGMENT_META.map((g) => [g.id, g.defaultOn]),
  ) as Record<SegmentId, boolean>;

  const ekg = createEkgTrace(ekgHost);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1218);
  scene.fog = new THREE.FogExp2(0x0a1218, 0.045);

  const bgGeo = new THREE.SphereGeometry(40, 32, 16);
  const bgMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      colorCenter: { value: new THREE.Color(0x12202a) },
      colorEdge: { value: new THREE.Color(0x070c10) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colorCenter;
      uniform vec3 colorEdge;
      varying vec3 vPos;
      void main() {
        vec3 n = normalize(vPos);
        float h = n.y * 0.5 + 0.5;
        float glow = pow(max(0.0, 1.0 - length(n.xz)), 2.2) * 0.2;
        vec3 col = mix(colorEdge, colorCenter, h);
        col += vec3(0.08, 0.18, 0.22) * glow;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(bgGeo, bgMat));

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const defaultCamPos = new THREE.Vector3();
  const defaultTarget = new THREE.Vector3();
  camera.up.set(0, 1, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  canvasHost.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 16;
  controls.update();

  /** While true, splitter/resize re-applies the default AP framing in the 3D pane. */
  let framingLocked = true;
  controls.addEventListener("start", () => {
    framingLocked = false;
  });

  /**
   * AP head-on. Puts the AV node on the geometric center of the 3D pane
   * (NDC 0,0), and fits the full model to the pane aspect.
   */
  function frameDefaultView() {
    const w = Math.max(1, canvasHost.clientWidth || window.innerWidth);
    const h = Math.max(1, canvasHost.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();

    conduction.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(conduction.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());

    // Prefer the live AV mesh world position (true visual center target)
    const focus = new THREE.Vector3();
    let foundAv = false;
    conduction.root.traverse((obj) => {
      if (foundAv) return;
      if (obj instanceof THREE.Mesh && obj.userData.segmentId === "av") {
        obj.getWorldPosition(focus);
        foundAv = true;
      }
    });
    if (!foundAv) focus.copy(conduction.getLandmarkWorld("av"));

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const limFov = Math.min(vFov, hFov);
    const fitRadius = sphere.radius + sphere.center.distanceTo(focus);
    // ~2.25× tighter than a full-sphere fit so the heart fills the pane
    const dist = (fitRadius * 1.06) / Math.tan(limFov / 2) / 2.25;

    // AP: camera on +Z looking at AV — AV projects to pane center
    camera.position.set(focus.x, focus.y, focus.z + dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(focus);
    controls.target.copy(focus);
    controls.minDistance = Math.max(0.6, dist * 0.25);
    controls.maxDistance = Math.max(10, dist * 4);
    controls.update();

    defaultCamPos.copy(camera.position);
    defaultTarget.copy(focus);
  }

  function resetCameraView() {
    framingLocked = true;
    frameDefaultView();
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0xfff0e8, 1.0);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88c8e0, 0.45);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x3db8c8, 0.25);
  rim.position.set(0, -2, -4);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 64),
    new THREE.MeshStandardMaterial({
      color: 0x152028,
      roughness: 0.9,
      metalness: 0.1,
      transparent: true,
      opacity: 0.55,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.55;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.35, 2.42, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3db8c8,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -1.54;
  scene.add(ring);

  const conduction: ConductionSystem = createConductionSystem();
  scene.add(conduction.root);

  const stimMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0xf0c040,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
    }),
  );
  stimMarker.visible = false;
  stimMarker.name = "stimMarker";
  scene.add(stimMarker);

  const deviceLeads = createDeviceLeads();
  deviceLeads.root.position.copy(conduction.root.position);
  scene.add(deviceLeads.root);

  // Place ground under centered model
  {
    const box = new THREE.Box3().setFromObject(conduction.root);
    const minY = box.min.y;
    ground.position.y = minY - 0.12;
    ring.position.y = minY - 0.11;
  }

  const vectors = createActivationVectors(conduction.getPathwayProbes());
  scene.add(vectors.root);
  vectors.root.position.copy(conduction.root.position);

  const leads = createLeadPositions();
  scene.add(leads.root);
  leads.root.position.copy(conduction.root.position);

  function applySegmentVisibility() {
    for (const g of SEGMENT_META) {
      conduction.setSegmentVisibility(g.id, segmentVisibility[g.id]);
    }
    if (state.finding !== "wpw" && !segmentVisibility.accessory) {
      conduction.setAccessoryVisible(false);
    }
    const isFlutter = state.finding === "aflutterCcw" || state.finding === "aflutterCw";
    if (!isFlutter && !segmentVisibility.flutter) {
      conduction.setSegmentVisibility("flutter", false);
    }
  }
  applySegmentVisibility();

  function applyRateToEkg() {
    if (state.upload) {
      ekg.setCycleSec(state.upload.durationSec);
      return;
    }
    if (state.stim.site) {
      ekg.setCycleSec(
        cycleSecForRate(
          { ...getFinding("nsr"), cycleSec: 0.9, ventRateBpm: 60 },
          state.ventRateBpm,
        ),
      );
      return;
    }
    const f = getFinding(state.finding);
    ekg.setCycleSec(cycleSecForRate(f, state.ventRateBpm));
  }

  function syncRateUI(bpm: number) {
    state.ventRateBpm = Math.max(30, Math.min(200, Math.round(bpm)));
    (els["rate-slider"] as HTMLInputElement).value = String(state.ventRateBpm);
    (els["rate-input"] as HTMLInputElement).value = String(state.ventRateBpm);
    els["meta-rate"].textContent = `${state.ventRateBpm} bpm`;
    applyRateToEkg();
  }

  function activeBundleBlocks(): BundleBlockId[] {
    if (state.customBlockMode) return state.customBlocks;
    return blocksForFinding(state.finding);
  }

  function syncBranchBlockCheckboxes() {
    const active = new Set(activeBundleBlocks());
    els["branch-block-grid"].querySelectorAll<HTMLInputElement>("input[data-bundle-block]").forEach((input) => {
      const id = input.dataset.bundleBlock as BundleBlockId;
      input.checked = active.has(id);
    });
    const blocks = activeBundleBlocks();
    const desc = describeBundleBlocks(blocks);
    const bbbOpen =
      state.customBlockMode ||
      BBB_FINDING_IDS.has(state.finding) ||
      blocks.length > 0;
    els["bbb-options"].classList.toggle("is-open", bbbOpen);
    els["bbb-options"].setAttribute("aria-hidden", bbbOpen ? "false" : "true");
    els["btn-bbb"].classList.toggle("active", bbbOpen && !state.upload && !state.stim.site);
    els["bbb-result"].textContent =
      blocks.length === 0 ? "Select one or more tracts" : `${desc.short} · ${desc.detail}`;
  }

  function syncFindingUI() {
    const f = getFinding(state.finding);
    const stimSite = state.stim.site;
    const blocks = activeBundleBlocks();
    const blockDesc = describeBundleBlocks(blocks);
    const usingCustomBlocks = state.customBlockMode && blocks.length > 0;

    if (stimSite && !state.upload) {
      els["finding-name"].textContent = stimLabel(stimSite);
      els["finding-detail"].textContent = stimDetail(stimSite);
      els["meta-finding"].textContent = "STIM";
    } else if (usingCustomBlocks) {
      els["finding-name"].textContent = `Custom · ${blockDesc.name}`;
      els["finding-detail"].textContent = blockDesc.detail;
      els["meta-finding"].textContent = blockDesc.short;
    } else {
      els["finding-name"].textContent = state.upload ? `Upload · ${state.upload.name}` : f.name;
      els["finding-detail"].textContent = state.upload
        ? `${layoutLabel(state.upload.layout)} · ${state.upload.availableLeads.join(", ")} · ~${state.upload.rateBpm} bpm`
        : f.detail;
      els["meta-finding"].textContent = state.upload ? "UPLOAD" : f.short;
    }
    els["finding-grid"].querySelectorAll<HTMLButtonElement>("button[data-finding]").forEach((btn) => {
      btn.classList.toggle(
        "active",
        !state.upload && !stimSite && !usingCustomBlocks && btn.dataset.finding === state.finding,
      );
    });
    ekg.setFinding(state.finding);
    ekg.setUpload(state.upload);
    if (stimSite && !state.upload) {
      ekg.setCustomSample((t) => sampleStim(stimSite, t));
      ekg.setCycleSec(cycleSecForRate({ ...f, cycleSec: 0.9, ventRateBpm: 60 }, state.ventRateBpm));
    } else if (usingCustomBlocks) {
      ekg.setCustomSample((t) => sampleFromBundleBlocks(blocks, t));
      ekg.setCycleSec(cycleSecForRate(f, state.ventRateBpm));
    } else {
      ekg.setCustomSample(null);
    }

    els["btn-stim"].classList.toggle("active", state.stim.armed);
    els["stim-hint"].hidden = !state.stim.armed;
    canvasHost.classList.toggle("stim-armed", state.stim.armed);
    stimMarker.visible = !!stimSite && !state.upload;

    if (state.finding === "wpw" && !state.upload) {
      segmentVisibility.accessory = true;
      const input = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="accessory"]',
      );
      if (input) input.checked = true;
    }
    if (
      (state.finding === "aflutterCcw" || state.finding === "aflutterCw") &&
      !state.upload
    ) {
      segmentVisibility.flutter = true;
      const input = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="flutter"]',
      );
      if (input) input.checked = true;
    }
    applySegmentVisibility();
    if (!(stimSite && !state.upload)) applyRateToEkg();

    conduction.setBlockSite(
      stimSite || state.upload || usingCustomBlocks ? "none" : blockSiteForFinding(state.finding),
    );
    conduction.setBranchBlocks(
      stimSite || state.upload ? [] : lesionSegmentsForBlocks(blocks),
    );
    deviceLeads.setMode(
      stimSite || state.upload || usingCustomBlocks ? "none" : deviceModeForFinding(state.finding),
    );
    syncBranchBlockCheckboxes();
  }

  function setStimArmed(armed: boolean) {
    state.stim.armed = armed;
    if (armed) {
      state.upload = null;
      ekg.setUpload(null);
      els["upload-preview"].hidden = true;
    }
    syncFindingUI();
    syncViewLabel();
  }

  function applyStimSite(site: StimSite, worldPos: THREE.Vector3) {
    state.stim.site = site;
    state.stim.armed = false;
    state.elapsed = 0;
    state.upload = null;
    ekg.setUpload(null);
    els["upload-preview"].hidden = true;
    stimMarker.position.copy(worldPos);
    stimMarker.visible = true;
    syncRateUI(60);
    syncFindingUI();
    syncViewLabel();
    setPlaying(true);
  }

  function clearStim() {
    state.stim.armed = false;
    state.stim.site = null;
    stimMarker.visible = false;
    ekg.setCustomSample(null);
    syncFindingUI();
    syncViewLabel();
  }

  function setFinding(id: FindingId) {
    state.finding = id;
    state.elapsed = 0;
    state.upload = null;
    state.stim.armed = false;
    state.stim.site = null;
    state.customBlockMode = false;
    state.customBlocks = blocksForFinding(id);
    stimMarker.visible = false;
    ekg.setUpload(null);
    ekg.setCustomSample(null);
    els["upload-preview"].hidden = true;
    const f = getFinding(id);
    syncRateUI(f.ventRateBpm);
    syncFindingUI();
  }

  function setPlaying(playing: boolean) {
    state.playing = playing;
    els["btn-play"].textContent = playing ? "Pause" : "Play";
    els["btn-play"].classList.toggle("active", playing);
  }

  function syncViewLabel() {
    const label = document.querySelector(".pane-label");
    if (!label) return;
    const bits = ["Conduction"];
    if (state.vectorsOn) bits.push("vectors");
    if (state.fieldOn) bits.push("field");
    if (state.leadsOn) bits.push("leads");
    if (state.stim.site) bits.push("stim");
    if (state.stim.armed) bits.push("pick site");
    label.textContent = bits.length > 1 ? bits.join(" · ") : "Conduction";
  }

  function setVectors(on: boolean) {
    state.vectorsOn = on;
    vectors.setMeanVisible(on);
    els["btn-vectors"].classList.toggle("active", on);
    syncViewLabel();
  }

  function setField(on: boolean) {
    state.fieldOn = on;
    vectors.setFieldVisible(on);
    els["btn-field"].classList.toggle("active", on);
    syncViewLabel();
  }

  function setLeads(on: boolean) {
    state.leadsOn = on;
    leads.setVisible(on);
    els["btn-leads"].classList.toggle("active", on);
    syncViewLabel();
  }

  syncRateUI(70);
  syncFindingUI();
  setPlaying(true);
  setVectors(false);
  setField(false);
  setLeads(false);

  ekg.onScrub((deltaSec) => {
    if (state.playing) setPlaying(false);
    state.elapsed = Math.max(0, state.elapsed + deltaSec);
  });

  els["finding-grid"].addEventListener("click", (e) => {
    const bbbBtn = (e.target as HTMLElement).closest("#btn-bbb");
    if (bbbBtn) {
      const open = els["bbb-options"].classList.contains("is-open");
      if (open && (BBB_FINDING_IDS.has(state.finding) || state.customBlockMode)) {
        setFinding("nsr");
      } else {
        setFinding("rbbb");
      }
      return;
    }
    const btn = (e.target as HTMLElement).closest("button[data-finding]");
    if (!btn) return;
    const id = (btn as HTMLElement).dataset.finding as FindingId;
    setFinding(id);
  });

  const findingSearch = els["finding-search"] as HTMLInputElement;
  const findingEmpty = els["finding-empty"];
  const physioBlock = els["physionet-block"];
  const physioResults = els["physionet-results"];
  const physioHint = els["physionet-hint"];
  let physioSearchGen = 0;

  async function applyPhysioUpload(parsed: UploadedEkg) {
    if (state.upload?.imageUrl) URL.revokeObjectURL(state.upload.imageUrl);
    state.upload = parsed;
    state.stim.armed = false;
    state.stim.site = null;
    stimMarker.visible = false;
    ekg.setCustomSample(null);
    state.elapsed = 0;
    state.finding = suggestFindingFromUpload(parsed);
    syncRateUI(parsed.rateBpm);
    syncFindingUI();
    const thumb = els["upload-thumb"] as HTMLImageElement;
    thumb.hidden = true;
    els["upload-preview"].hidden = false;
    els["upload-meta"].textContent = `${parsed.name} · ${layoutLabel(parsed.layout)} · ${parsed.availableLeads.join(", ")} · ~${parsed.rateBpm} bpm`;
    setPlaying(true);
  }

  async function loadPhysioRecord(ref: PhysioRecordRef) {
    physioHint.textContent = `Loading ${ref.label}…`;
    try {
      const parsed = await loadPhysioNetRecord({
        database: ref.database,
        version: ref.version,
        record: ref.record,
        durationSec: 12,
      });
      await applyPhysioUpload(parsed);
      physioHint.textContent = `Loaded ${ref.label} · ${parsed.availableLeads.join(", ")}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load PhysioNet record";
      physioHint.textContent = msg;
      els["upload-preview"].hidden = false;
      els["upload-meta"].textContent = msg;
    }
  }

  function renderPhysioResults(opts: {
    records: PhysioRecordRef[];
    projects: Awaited<ReturnType<typeof searchPhysioNetProjects>>;
    dbs: ReturnType<typeof curatedDbMatches>;
    query: string;
  }) {
    const { records, projects, dbs, query } = opts;
    physioResults.innerHTML = "";
    const hasAnything = records.length > 0 || projects.length > 0 || dbs.length > 0;
    physioBlock.hidden = !query.trim() || (!hasAnything && query.trim().length < 2);
    if (physioBlock.hidden) return;

    if (!hasAnything) {
      physioHint.textContent = "No matches — try one of the examples above";
      return;
    }

    physioHint.textContent = "Click a record to load ~12s into the EKG pane";

    for (const db of dbs.slice(0, 4)) {
      const row = document.createElement("div");
      row.className = "physionet-db";
      row.innerHTML = `<strong>${db.title}</strong><span>${db.slug} · ${db.records.length} records</span>`;
      physioResults.appendChild(row);
    }

    for (const ref of records.slice(0, 18)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "physionet-record";
      btn.innerHTML = `<span class="physionet-record-id">${ref.label}</span><small>${ref.detail}</small>`;
      btn.title = `Load ${ref.label} from PhysioNet`;
      btn.addEventListener("click", () => void loadPhysioRecord(ref));
      physioResults.appendChild(btn);
    }

    for (const p of projects.slice(0, 6)) {
      if (CURATED_HAS.has(p.slug)) continue;
      const a = document.createElement("a");
      a.className = "physionet-project";
      a.href = p.sourceUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = `<span>${p.title}</span><small>${p.accessPolicy}${p.open ? " · open" : ""} · on PhysioNet ↗</small>`;
      physioResults.appendChild(a);
    }
  }

  const CURATED_HAS = new Set(
    ["mitdb", "nsrdb", "svdb", "afdb", "vfdb", "cudb"],
  );

  async function runPhysioSearch(q: string) {
    const gen = ++physioSearchGen;
    const records = searchCuratedRecords(q);
    const dbs = curatedDbMatches(q);
    let projects: Awaited<ReturnType<typeof searchPhysioNetProjects>> = [];
    try {
      if (q.trim().length >= 2) projects = await searchPhysioNetProjects(q);
    } catch {
      // Curated results still work without live API
      if (gen === physioSearchGen && records.length === 0 && dbs.length === 0) {
        physioHint.textContent =
          "PhysioNet API unreachable — curated teaching sets still searchable (mitdb, afdb…)";
      }
    }
    if (gen !== physioSearchGen) return;
    renderPhysioResults({ records, projects, dbs, query: q });
  }

  function filterFindings() {
    const q = findingSearch.value;
    let visible = 0;
    els["finding-grid"].querySelectorAll<HTMLButtonElement>("button[data-finding]").forEach((btn) => {
      const id = btn.dataset.finding as FindingId;
      const show = findingMatchesQuery(getFinding(id), q);
      btn.hidden = !show;
      if (show) visible += 1;
    });
    const bbbMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => f.category === "bbb" && findingMatchesQuery(f, q));
    const bbbBtn = els["btn-bbb"] as HTMLButtonElement;
    bbbBtn.hidden = !bbbMatch;
    if (bbbMatch) visible += 1;

    // Deep-link search: jump into matching BBB pattern
    const qLower = q.trim().toLowerCase();
    if (qLower.length >= 3) {
      const hit = FINDINGS.find(
        (f) => f.category === "bbb" && findingMatchesQuery(f, q) && (f.id === qLower || f.short.toLowerCase() === qLower || f.aliases?.some((a) => a === qLower)),
      );
      if (hit && state.finding !== hit.id) {
        // only auto-open panel; don't fight user mid-typing unless exact-ish
        els["bbb-options"].classList.add("is-open");
        els["bbb-options"].setAttribute("aria-hidden", "false");
      }
    }

    findingEmpty.hidden = visible > 0 || q.trim().length === 0;
    void runPhysioSearch(q);
  }

  let searchTimer = 0;
  findingSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => filterFindings(), 180);
  });

  els["btn-stim"].addEventListener("click", () => setStimArmed(!state.stim.armed));
  els["btn-stim-clear"].addEventListener("click", () => clearStim());

  const CARDIOVERTIBLE = new Set<FindingId>([
    "afib",
    "aflutterCcw",
    "aflutterCw",
    "vt",
    "vtMonoLbbb",
    "vtMonoRbbb",
    "vtPoly",
    "torsades",
    "vf",
    "sinusTachy",
  ]);

  function flashCardioversion() {
    const flash = document.createElement("div");
    flash.className = "cv-flash";
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add("on"));
    window.setTimeout(() => {
      flash.classList.remove("on");
      window.setTimeout(() => flash.remove(), 280);
    }, 120);
  }

  function cardiovert() {
    flashCardioversion();
    clearStim();
    state.upload = null;
    ekg.setUpload(null);
    els["upload-preview"].hidden = true;
    // Brief post-shock pause then NSR
    state.elapsed = 0;
    if (CARDIOVERTIBLE.has(state.finding) || state.finding !== "nsr") {
      setFinding("nsr");
    } else {
      state.elapsed = 0;
    }
    setPlaying(true);
    els["phase-chip"].textContent = "Post-cardioversion · NSR";
  }

  els["btn-cv"].addEventListener("click", () => cardiovert());

  els["btn-play"].addEventListener("click", () => setPlaying(!state.playing));
  els["btn-reset"].addEventListener("click", () => {
    state.elapsed = 0;
  });
  els["btn-view-reset"].addEventListener("click", () => resetCameraView());
  els["btn-heart"].addEventListener("click", () => {
    state.heartVisible = !state.heartVisible;
    conduction.heartShell.visible = state.heartVisible;
  });
  els["btn-vectors"].addEventListener("click", () => setVectors(!state.vectorsOn));
  els["btn-field"].addEventListener("click", () => setField(!state.fieldOn));
  els["btn-leads"].addEventListener("click", () => setLeads(!state.leadsOn));

  const onRateChange = (raw: number) => {
    syncRateUI(raw);
  };
  els["rate-slider"].addEventListener("input", () => {
    onRateChange(Number((els["rate-slider"] as HTMLInputElement).value));
  });
  els["rate-input"].addEventListener("input", () => {
    const raw = (els["rate-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    onRateChange(Number(raw));
  });
  els["rate-input"].addEventListener("change", () => {
    onRateChange(Number((els["rate-input"] as HTMLInputElement).value) || 70);
  });

  function syncSpeedUI(pct: number) {
    const clamped = Math.max(25, Math.min(200, Math.round(pct / 5) * 5));
    state.playbackSpeed = clamped / 100;
    (els["speed-slider"] as HTMLInputElement).value = String(clamped);
    (els["speed-input"] as HTMLInputElement).value = String(clamped);
  }

  els["speed-slider"].addEventListener("input", () => {
    syncSpeedUI(Number((els["speed-slider"] as HTMLInputElement).value));
  });
  els["speed-input"].addEventListener("input", () => {
    const raw = (els["speed-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    syncSpeedUI(Number(raw));
  });
  els["speed-input"].addEventListener("change", () => {
    syncSpeedUI(Number((els["speed-input"] as HTMLInputElement).value) || 100);
  });
  syncSpeedUI(100);

  function readBranchBlockToggles(): BundleBlockId[] {
    const out: BundleBlockId[] = [];
    els["branch-block-grid"].querySelectorAll<HTMLInputElement>("input[data-bundle-block]").forEach((input) => {
      if (input.checked) out.push(input.dataset.bundleBlock as BundleBlockId);
    });
    return out;
  }

  els["branch-block-grid"].addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.bundleBlock) return;
    clearStim();
    state.upload = null;
    ekg.setUpload(null);
    els["upload-preview"].hidden = true;
    const next = readBranchBlockToggles();
    state.customBlocks = next;
    state.customBlockMode = next.length > 0;
    state.finding = findingIdForBlocks(next);
    state.elapsed = 0;
    syncRateUI(getFinding(state.finding).ventRateBpm);
    syncFindingUI();
    setPlaying(true);
  });

  els["btn-block-clear"].addEventListener("click", () => {
    state.customBlocks = [];
    state.customBlockMode = false;
    clearStim();
    if (blocksForFinding(state.finding).length > 0) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-collapse"].addEventListener("click", () =>
    els["panel-shell"].classList.add("collapsed"),
  );
  els["btn-expand"].addEventListener("click", () =>
    els["panel-shell"].classList.remove("collapsed"),
  );

  function syncSegCheckboxes() {
    els["segment-toggles"].querySelectorAll<HTMLInputElement>("input[data-segment]").forEach((input) => {
      const id = input.dataset.segment as SegmentId;
      input.checked = segmentVisibility[id];
    });
  }

  els["segment-toggles"].addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.segment) return;
    const id = input.dataset.segment as SegmentId;
    segmentVisibility[id] = input.checked;
    conduction.setSegmentVisibility(id, input.checked);
  });

  els["btn-seg-all"].addEventListener("click", () => {
    for (const g of SEGMENT_META) {
      if (g.id === "myocardiumA" || g.id === "myocardiumV") continue;
      segmentVisibility[g.id] = true;
    }
    applySegmentVisibility();
    syncSegCheckboxes();
  });

  els["btn-seg-none"].addEventListener("click", () => {
    for (const g of SEGMENT_META) {
      if (g.id === "myocardiumA" || g.id === "myocardiumV") continue;
      segmentVisibility[g.id] = false;
    }
    applySegmentVisibility();
    syncSegCheckboxes();
  });

  // Upload
  els["ekg-file"].addEventListener("change", async () => {
    const input = els["ekg-file"] as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      els["upload-meta"].textContent = "Parsing…";
      els["upload-preview"].hidden = false;
      const thumb = els["upload-thumb"] as HTMLImageElement;
      thumb.hidden = true;
      const parsed = await parseEkgFile(file);
      state.upload = parsed;
      state.stim.armed = false;
      state.stim.site = null;
      stimMarker.visible = false;
      ekg.setCustomSample(null);
      state.elapsed = 0;
      const suggested = suggestFindingFromUpload(parsed);
      state.finding = suggested;
      syncRateUI(parsed.rateBpm);
      syncFindingUI();
      if (parsed.imageUrl) {
        thumb.src = parsed.imageUrl;
        thumb.hidden = false;
      }
      els["upload-meta"].textContent = `${parsed.name} · ${layoutLabel(parsed.layout)} · ${parsed.availableLeads.length} lead${parsed.availableLeads.length === 1 ? "" : "s"} · ~${parsed.rateBpm} bpm`;
      setPlaying(true);
    } catch (err) {
      els["upload-meta"].textContent =
        err instanceof Error ? err.message : "Could not parse EKG";
    } finally {
      input.value = "";
    }
  });

  els["btn-clear-upload"].addEventListener("click", () => {
    if (state.upload?.imageUrl) URL.revokeObjectURL(state.upload.imageUrl);
    state.upload = null;
    els["upload-preview"].hidden = true;
    syncFindingUI();
  });

  // Hover tooltips — immediate label of conduction structure
  const tooltip = els["seg-tooltip"];
  const tipGroup = tooltip.querySelector(".seg-tooltip-group") as HTMLElement;
  const tipName = tooltip.querySelector(".seg-tooltip-name") as HTMLElement;
  const tipDetail = tooltip.querySelector(".seg-tooltip-detail") as HTMLElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoverMesh: THREE.Mesh | null = null;
  let pointerClient = { x: 0, y: 0 };
  let isDragging = false;

  function clearHoverHighlight() {
    if (!hoverMesh) return;
    hoverMesh.userData.hovered = false;
    const mat = hoverMesh.material;
    if (mat instanceof THREE.MeshStandardMaterial && hoverMesh.userData.isAnatomyGuide) {
      mat.emissiveIntensity = Number(hoverMesh.userData.baseEmissive ?? 0.08);
      mat.opacity = 0.42;
    }
  }

  function clearHover() {
    clearHoverHighlight();
    tooltip.hidden = true;
    hoverMesh = null;
  }

  function showHover(mesh: THREE.Mesh) {
    clearHoverHighlight();
    hoverMesh = mesh;
    mesh.userData.hovered = true;
    if (mesh.userData.isAnatomyGuide) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.emissiveIntensity = 0.35;
        mat.opacity = 0.7;
      }
    }
    const segId = String(mesh.userData.segmentId ?? "");
    if (mesh.userData.isAnatomyGuide) {
      tipGroup.textContent = "Anatomy";
      tipGroup.style.color = "#8a9aa8";
    } else {
      const group = SEGMENT_META.find((s) => s.id === segId);
      tipGroup.textContent = group?.label ?? "Conduction";
      tipGroup.style.color = group?.color ?? "var(--accent)";
    }
    tipName.textContent = String(mesh.userData.segmentName ?? mesh.name ?? "Pathway");
    tipDetail.textContent = String(mesh.userData.segmentDetail ?? "");
    tooltip.hidden = false;
    positionTooltip();
  }

  function positionTooltip() {
    const pad = 12;
    const tw = tooltip.offsetWidth || 160;
    const th = tooltip.offsetHeight || 40;
    let x = pointerClient.x + pad;
    let y = pointerClient.y + pad;
    if (x + tw > window.innerWidth - 8) x = pointerClient.x - tw - pad;
    if (y + th > window.innerHeight - 8) y = pointerClient.y - th - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function pickSegment(clientX: number, clientY: number): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    conduction.root.traverse((obj) => {
      if (
        obj instanceof THREE.Mesh &&
        obj.visible &&
        (obj.userData.isConduction || obj.userData.isAnatomyGuide)
      ) {
        targets.push(obj);
      }
    });
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? (hits[0]!.object as THREE.Mesh) : null;
  }

  function pickStimHit(
    clientX: number,
    clientY: number,
  ): { site: StimSite; worldPos: THREE.Vector3 } | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    conduction.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.visible && obj.userData.isConduction) {
        targets.push(obj);
      }
    });
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit) return null;
    const mesh = hit.object as THREE.Mesh;
    const segmentId = mesh.userData.segmentId as SegmentId | undefined;
    if (!segmentId || segmentId === ("guide" as SegmentId)) return null;

    let pathU = hit.uv?.x;
    if (pathU == null || Number.isNaN(pathU)) {
      const curve = mesh.userData.curve as THREE.CatmullRomCurve3 | undefined;
      if (curve) {
        const local = conduction.root.worldToLocal(hit.point.clone());
        let bestU = 0.5;
        let bestD = Infinity;
        for (let i = 0; i <= 40; i++) {
          const u = i / 40;
          const d = curve.getPointAt(u).distanceToSquared(local);
          if (d < bestD) {
            bestD = d;
            bestU = u;
          }
        }
        pathU = bestU;
      } else {
        pathU = segmentId === "av" ? 0.5 : 0;
      }
    }

    const site: StimSite = {
      segmentId,
      curveIndex: typeof mesh.userData.curveIndex === "number" ? mesh.userData.curveIndex : undefined,
      pathU,
      name: String(mesh.userData.segmentName ?? mesh.name ?? segmentId),
      detail: String(mesh.userData.segmentDetail ?? ""),
    };
    return { site, worldPos: hit.point.clone() };
  }

  let stimPointerDown = { x: 0, y: 0, t: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!state.stim.armed || e.button !== 0) return;
    stimPointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!state.stim.armed || e.button !== 0) return;
    const dx = e.clientX - stimPointerDown.x;
    const dy = e.clientY - stimPointerDown.y;
    if (dx * dx + dy * dy > 36) return; // treat as orbit drag
    if (performance.now() - stimPointerDown.t > 500) return;
    const picked = pickStimHit(e.clientX, e.clientY);
    if (!picked) return;
    e.preventDefault();
    applyStimSite(picked.site, picked.worldPos);
  });

  renderer.domElement.addEventListener("pointermove", (e) => {
    pointerClient = { x: e.clientX, y: e.clientY };
    if (isDragging) {
      clearHover();
      return;
    }
    if (!tooltip.hidden) positionTooltip();

    const hit = pickSegment(e.clientX, e.clientY);
    if (hit === hoverMesh) return;
    if (!hit) {
      clearHover();
      return;
    }
    showHover(hit);
  });

  renderer.domElement.addEventListener("pointerleave", () => clearHover());
  controls.addEventListener("start", () => {
    isDragging = true;
    clearHover();
  });
  controls.addEventListener("end", () => {
    isDragging = false;
  });

  function resize() {
    const host = canvasHost;
    const w = Math.max(1, host.clientWidth || window.innerWidth);
    const h = Math.max(1, host.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // updateStyle=true so CSS size matches the pane (avoids DPR canvas overflow
    // clipping the projection center into the lower-right)
    renderer.setSize(w, h, true);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    ekg.resize();
    if (framingLocked) frameDefaultView();
  }

  // Draggable splitter: stacked only in portrait; landscape stays side-by-side
  const stage = document.querySelector("#stage") as HTMLElement;
  const splitter = document.querySelector("#splitter") as HTMLElement;
  const STACK_MAX_WIDTH = 900;
  const MIN_PANE = 180;

  function useStackedSplit(): boolean {
    return (
      window.innerWidth <= STACK_MAX_WIDTH &&
      window.matchMedia("(orientation: portrait)").matches
    );
  }

  function applySplit(primaryPx: number) {
    const rect = stage.getBoundingClientRect();
    const splitSize = 6;
    const stacked = useStackedSplit();
    if (stacked) {
      const max = rect.height - splitSize - MIN_PANE;
      const clamped = Math.max(MIN_PANE, Math.min(max, primaryPx));
      stage.style.gridTemplateRows = `${clamped}px ${splitSize}px 1fr`;
      stage.style.gridTemplateColumns = "1fr";
    } else {
      const max = rect.width - splitSize - MIN_PANE;
      const clamped = Math.max(MIN_PANE, Math.min(max, primaryPx));
      stage.style.gridTemplateColumns = `${clamped}px ${splitSize}px 1fr`;
      stage.style.gridTemplateRows = "1fr";
    }
    resize();
  }

  function startSplitDrag(clientPos: number) {
    const rect = stage.getBoundingClientRect();
    const stacked = useStackedSplit();
    const origin = stacked ? rect.top : rect.left;
    document.body.classList.add("is-resizing");

    const onMove = (ev: PointerEvent) => {
      const pos = stacked ? ev.clientY : ev.clientX;
      applySplit(pos - origin);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    applySplit(clientPos - origin);
  }

  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture?.(e.pointerId);
    const stacked = useStackedSplit();
    startSplitDrag(stacked ? e.clientY : e.clientX);
  });

  splitter.addEventListener("keydown", (e) => {
    const stacked = useStackedSplit();
    const rect = stage.getBoundingClientRect();
    const current = stacked
      ? (document.querySelector("#view-3d") as HTMLElement).offsetHeight
      : (document.querySelector("#view-3d") as HTMLElement).offsetWidth;
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      applySplit(current - step);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      applySplit(current + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      applySplit(stacked ? rect.height * 0.45 : rect.width / (1 + 1.35));
    }
  });

  window.addEventListener("resize", () => {
    // Drop locked px sizes when orientation / breakpoint flips so CSS defaults apply
    const stacked = useStackedSplit();
    if (stacked) {
      if (stage.style.gridTemplateColumns !== "1fr") {
        stage.style.gridTemplateColumns = "";
        stage.style.gridTemplateRows = "";
      }
    } else if (stage.style.gridTemplateRows && stage.style.gridTemplateRows !== "1fr") {
      stage.style.gridTemplateColumns = "";
      stage.style.gridTemplateRows = "";
    }
    resize();
  });
  // Phones fire this on rotate even when width stays similar
  window.matchMedia("(orientation: portrait)").addEventListener("change", () => {
    stage.style.gridTemplateColumns = "";
    stage.style.gridTemplateRows = "";
    resize();
  });
  resize();

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === "r" || e.key === "R") {
      state.elapsed = 0;
    } else if (e.key === "v" || e.key === "V") {
      setVectors(!state.vectorsOn);
    } else if (e.key === "f" || e.key === "F") {
      setField(!state.fieldOn);
    } else if (e.key === "l" || e.key === "L") {
      setLeads(!state.leadsOn);
    }
  });

  let last = performance.now();
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (state.playing) {
      let pace = 1;
      if (state.upload) {
        pace = state.ventRateBpm / Math.max(30, state.upload.rateBpm);
      }
      state.elapsed += dt * pace * state.playbackSpeed;
    }

    const { phase, active, mark, tCycle, leads } = ekg.update(state.elapsed);
    els["phase-chip"].textContent = phase;
    els["ekg-footer"].innerHTML = `<strong>${mark}</strong> · ${phase} — impulse travels the pathways${state.fieldOn ? " · field on" : ""}${state.leadsOn ? " · leads on" : ""}.`;

    const lit = active.filter((id) => segmentVisibility[id] !== false);
    const stimBranches = state.stim.site && !state.upload ? branchesFromStim(state.stim.site) : undefined;
    const blockBranches =
      !stimBranches && state.customBlockMode && state.customBlocks.length > 0
        ? branchesFromBundleBlocks(state.customBlocks)
        : undefined;
    const pathBranches = stimBranches ?? blockBranches;
    conduction.setSegmentActive({
      active: lit,
      tCycle,
      finding: state.finding,
      mark,
      branches: pathBranches,
      intensity: 0.95,
    });
    conduction.updateImpulse({
      tCycle,
      active: lit,
      finding: state.finding,
      mark,
      branches: pathBranches,
    });
    conduction.updateBlockSitePulse(now / 1000);

    vectors.update({
      mark,
      active: lit,
      finding: state.finding,
      tCycle,
      leads,
      branches: pathBranches,
      fronts: conduction.getActiveFronts({
        tCycle,
        finding: state.finding,
        mark,
        branches: pathBranches,
      }),
    });

    if (conduction.pulse.visible) {
      const s = 1 + 0.2 * Math.sin(now * 0.014);
      conduction.pulse.scale.setScalar(s);
    }

    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

try {
  main();
} catch (err) {
  const app = document.querySelector("#app");
  const msg = err instanceof Error ? err.message : String(err);
  if (app) {
    app.innerHTML = `<div id="boot-error"><strong>EKG View failed to start.</strong><p>Try a hard refresh (Ctrl+Shift+R). If it keeps failing, open the browser console for details.</p><p><code>${msg}</code></p></div>`;
  }
  console.error(err);
}
