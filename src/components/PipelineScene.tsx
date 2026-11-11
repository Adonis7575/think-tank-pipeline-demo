"use client";

// PipelineScene.tsx — the 3D stage.
// Three holographic HUMANOID agents standing on a neon grid, connected by
// bezier particle data-streams. Each bot keeps its signature polyhedron as its
// head + chest core (octahedron / tetrahedron / icosahedron).
//
// Interactions:
//   drag = orbit camera · scroll = zoom · hover = bot turns its head to you
//   click a bot = it waves, opens its output tab, camera focuses on it
//   click empty space = camera recenters
//
// Status-driven poses: idle breathing · queued (head down, dim) ·
// processing (arms working a holo-console, typing motion) · complete (salute).

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { frameBlend, motionBlend, nearestAngle, SceneGesture, zoomRadius } from "@/lib/scene-motion";

export type AgentSceneStatus = "idle" | "waiting" | "running" | "done";
export type SceneFocus = "studio" | "gym";
export type SceneQuality = "auto" | "eco";

export interface SceneAgent {
  id: string;
  label: string;
  color: string;
  status: AgentSceneStatus;
  progress: number; // 0..1
  trainingActive?: boolean;
  trainingLevel?: number;
  trainingProgress?: number;
  supports: Array<{
    id: string;
    label: string;
    role: string;
    trainingLevel?: number;
  }>;
}

interface Props {
  agents: SceneAgent[];
  focusZone?: SceneFocus;
  quality?: SceneQuality;
  reduceMotion?: boolean;
  ambientPaused?: boolean;
  onAgentClick?: (id: string) => void;
  onLibraryClick?: () => void;
}

const STATUS_TEXT: Record<AgentSceneStatus, string> = {
  idle: "STANDBY",
  waiting: "QUEUED",
  running: "PROCESSING",
  done: "COMPLETE",
};

const ENERGY_TARGET: Record<AgentSceneStatus, number> = {
  idle: 0.3,
  waiting: 0.16,
  running: 1.0,
  done: 0.66,
};

const FLOOR_Y = -1.97;

function makeGlowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(0.6, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeGymSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(10, 18, 20, 0.94)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(117, 200, 185, 0.7)";
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = "#b8ddd3";
  ctx.font = "700 58px Segoe UI, sans-serif";
  ctx.letterSpacing = "12px";
  ctx.fillText("SKILL GYM", 54, 112);
  ctx.fillStyle = "rgba(184, 221, 211, 0.68)";
  ctx.font = "600 25px Segoe UI, sans-serif";
  ctx.letterSpacing = "7px";
  ctx.fillText("ON-DEVICE PRACTICE", 58, 178);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

interface BotJoints {
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  halo: THREE.Mesh;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  ankleL: THREE.Group;
  ankleR: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  wristL: THREE.Group;
  wristR: THREE.Group;
}

interface BotMats {
  solid: THREE.MeshBasicMaterial;
  wire: THREE.MeshBasicMaterial;
  core: THREE.MeshBasicMaterial;
  halo: THREE.MeshBasicMaterial;
  shell: THREE.MeshStandardMaterial;
  joint: THREE.MeshStandardMaterial;
  visor: THREE.MeshBasicMaterial;
  chestGlow: THREE.SpriteMaterial;
  headGlow: THREE.SpriteMaterial;
}

interface AgentRig {
  root: THREE.Group;
  joints: BotJoints;
  mats: BotMats;
  motes: THREE.Points;
  motesMat: THREE.PointsMaterial;
  billboard: THREE.Group;
  progressMesh: THREE.Mesh;
  progressMat: THREE.MeshBasicMaterial;
  trackMat: THREE.MeshBasicMaterial;
  pillar: THREE.Mesh;
  pillarMat: THREE.MeshBasicMaterial;
  pad: THREE.Mesh;
  padMat: THREE.MeshBasicMaterial;
  lastProgress: number;
  energy: number;
  headYaw: number;
  prevStatus: AgentSceneStatus;
  waveUntil: number;
  chestAnchor: THREE.Vector3;
  home: THREE.Vector3;
  waypoints: THREE.Vector3[];
  waypointIndex: number;
  pauseUntil: number;
  walkBlend: number;
  moveSpeed: number;
  gaitPhase: number;
  facingYaw: number;
  celebrateUntil: number;
}

interface SupportJoints {
  torso: THREE.Group;
  head: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
}

interface SupportRig {
  root: THREE.Group;
  joints: SupportJoints;
  parentIndex: number;
  supportIndex: number;
  label: string;
  role: string;
  home: THREE.Vector3;
  anchor: THREE.Vector3;
  phase: number;
  energy: number;
  shellMat: THREE.MeshStandardMaterial;
  glowMat: THREE.MeshBasicMaterial;
  visorMat: THREE.MeshBasicMaterial;
  pad: THREE.Mesh;
  padMat: THREE.MeshBasicMaterial;
}

interface SupportRelay {
  curve: THREE.QuadraticBezierCurve3;
  line: THREE.Line;
  geo: THREE.BufferGeometry;
  mat: THREE.LineBasicMaterial;
  bead: THREE.Mesh;
  beadMat: THREE.MeshBasicMaterial;
  parentIndex: number;
  supportIndex: number;
}

interface LinkRig {
  points: THREE.Points;
  mat: THREE.PointsMaterial;
  geo: THREE.BufferGeometry;
  curve: THREE.QuadraticBezierCurve3;
  offsets: Float32Array;
  jitter: Float32Array;
  colorFrom: THREE.Color;
  colorTo: THREE.Color;
  activity: number;
  count: number;
  activator: number;
  arcHeight: number;
  fromAgent: number | null;
  toAgent: number;
}

interface Shockwave {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  born: number;
}

export default function PipelineScene({
  agents,
  focusZone = "studio",
  quality = "auto",
  reduceMotion,
  ambientPaused = false,
  onAgentClick,
  onLibraryClick,
}: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const supportLabelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const propsRef = useRef<Props>({ agents, focusZone, quality, reduceMotion, ambientPaused, onAgentClick, onLibraryClick });
  propsRef.current = { agents, focusZone, quality, reduceMotion, ambientPaused, onAgentClick, onLibraryClick };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let systemReducedMotion = motionPreference.matches;
    let reducedMotion = reduceMotion ?? systemReducedMotion;
    const lowPower =
      window.innerWidth < 900 || (navigator.hardwareConcurrency ?? 8) <= 4;

    // --- Renderer / scene / camera / bloom ---
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return;
    }
    const autoPixelRatio = Math.min(
      window.devicePixelRatio,
      lowPower ? 1.15 : 1.5
    );
    renderer.setPixelRatio(quality === "eco" ? 1 : autoPixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setClearColor(0x0a0e14, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0a0e14, 0.016);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnvironment = new RoomEnvironment();
    const environmentTexture = pmrem.fromScene(roomEnvironment, 0.045).texture;
    scene.environment = environmentTexture;
    roomEnvironment.dispose();
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(
      48,
      mount.clientWidth / mount.clientHeight,
      0.1,
      200
    );
    const overviewTarget = new THREE.Vector3(0, -0.48, -0.8);
    const overviewAzimuth = -0.38;
    const overviewPolar = 1.22;
    const overviewRadius =
      mount.clientWidth / Math.max(1, mount.clientHeight) < 1.35 ? 17.4 : 14.8;
    const gymTarget = new THREE.Vector3(-18.25, -0.48, -0.25);
    const gymAzimuth = 0.32;
    const gymPolar = 1.24;
    const gymRadius =
      mount.clientWidth / Math.max(1, mount.clientHeight) < 1.35 ? 12.4 : 10.2;
    const initialFocus = focusZone === "gym" ? "gym" : "studio";
    const camTarget =
      initialFocus === "gym" ? gymTarget.clone() : overviewTarget.clone();
    const camTargetT = camTarget.clone();
    let azimuth = initialFocus === "gym" ? gymAzimuth : overviewAzimuth;
    let polar = initialFocus === "gym" ? gymPolar : overviewPolar;
    let radius = initialFocus === "gym" ? gymRadius : overviewRadius;
    let azimuthT = azimuth;
    let polarT = polar;
    let radiusT = radius;
    let activeFocusZone: SceneFocus = initialFocus;
    const applyCameraFocus = (zone: SceneFocus) => {
      activeFocusZone = zone;
      if (zone === "gym") {
        camTargetT.copy(gymTarget);
        azimuthT = nearestAngle(gymAzimuth, azimuth);
        polarT = gymPolar;
        radiusT = gymRadius;
      } else {
        camTargetT.copy(overviewTarget);
        azimuthT = nearestAngle(overviewAzimuth, azimuth);
        polarT = overviewPolar;
        radiusT = overviewRadius;
      }
    };
    let dragging = false;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight),
      quality === "eco" ? 0.24 : lowPower ? 0.34 : 0.46,
      0.42,
      0.25
    );
    bloomPass.enabled = quality !== "eco";
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const glowTex = makeGlowTexture();

    // --- Environment: a warm, open orbital studio ---
    const agentX = [-5.2, 0, 5.2];
    const supportHomes = agentX.flatMap((x) => [
      new THREE.Vector3(x - 1.28, FLOOR_Y, -2.08),
      new THREE.Vector3(x + 1.28, FLOOR_Y, -2.08),
    ]);
    const office = new THREE.Group();
    scene.add(office);

    // Blender bridge: authored glTF set dressing can be swapped without
    // rebuilding the interactive agent rigs. The procedural office remains the
    // resilient fallback if an asset is unavailable or still being iterated on.
    let sceneDisposed = false;
    const disposeObject = (root: THREE.Object3D) => {
      const textures = new Set<THREE.Texture>();
      const disposeMaterial = (material: THREE.Material) => {
        Object.values(material).forEach((value) => {
          if (value instanceof THREE.Texture) textures.add(value);
        });
        material.dispose();
      };
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        const materials = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(materials)) materials.forEach(disposeMaterial);
        else if (materials) disposeMaterial(materials);
      });
      textures.forEach((texture) => texture.dispose());
    };
    scene.add(new THREE.HemisphereLight(0x9ab6d6, 0x342219, 1.7));
    const windowLight = new THREE.DirectionalLight(0xa8c4df, 1.42);
    windowLight.position.set(-4, 7, -8);
    scene.add(windowLight);

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x111820,
      metalness: 0.32,
      roughness: 0.72,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x1a2530,
      metalness: 0.68,
      roughness: 0.34,
    });
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x11161c,
      metalness: 0.18,
      roughness: 0.84,
    });
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x453126,
      metalness: 0.08,
      roughness: 0.72,
    });
    const softMat = new THREE.MeshStandardMaterial({
      color: 0x29313b,
      metalness: 0.05,
      roughness: 0.94,
    });
    const plantMat = new THREE.MeshStandardMaterial({
      color: 0x315947,
      metalness: 0.02,
      roughness: 0.88,
    });
    const amberGlowMat = new THREE.MeshBasicMaterial({
      color: 0xf0ad68,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0x8b6848,
      metalness: 0.72,
      roughness: 0.28,
    });
    const floorInlayMat = new THREE.MeshStandardMaterial({
      color: 0x4f3d31,
      emissive: 0x24170f,
      emissiveIntensity: 0.18,
      metalness: 0.5,
      roughness: 0.58,
    });
    const gymFloorMat = new THREE.MeshStandardMaterial({
      color: 0x13201f,
      emissive: 0x07110f,
      emissiveIntensity: 0.22,
      metalness: 0.42,
      roughness: 0.7,
    });
    const gymInlayMat = new THREE.MeshStandardMaterial({
      color: 0x406c67,
      emissive: 0x143c35,
      emissiveIntensity: 0.42,
      metalness: 0.54,
      roughness: 0.42,
    });
    const gymGlowMat = new THREE.MeshBasicMaterial({
      color: 0x78c9b8,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const darkMetalMat = new THREE.MeshStandardMaterial({
      color: 0x111820,
      metalness: 0.86,
      roughness: 0.24,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x58738b,
      metalness: 0.08,
      roughness: 0.18,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const warmFabricMat = new THREE.MeshStandardMaterial({
      color: 0x6b4d3e,
      metalness: 0.02,
      roughness: 0.97,
    });
    const paperMat = new THREE.MeshStandardMaterial({
      color: 0xb8aa91,
      metalness: 0,
      roughness: 0.92,
    });

    const addBox = (
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material,
      parent: THREE.Object3D = office
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      parent.add(mesh);
      return mesh;
    };

    const addRoundedBox = (
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material,
      radius = 0.08,
      parent: THREE.Object3D = office
    ) => {
      const safeRadius = Math.min(radius, ...size.map((value) => value / 2.1));
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(size[0], size[1], size[2], 3, safeRadius),
        material
      );
      mesh.position.set(...position);
      parent.add(mesh);
      return mesh;
    };

    addBox([28, 0.18, 17], [0, FLOOR_Y - 0.1, -0.45], floorMat);
    addBox([17.6, 0.028, 6.7], [0, FLOOR_Y + 0.012, 0], softMat);
    addBox([0.18, 4.4, 4.5], [-14, 0.2, -6.55], wallMat);
    addBox([0.18, 4.4, 3.6], [-14, 0.2, 6.1], wallMat);
    addBox([0.18, 4.4, 16.7], [14, 0.2, -0.45], wallMat);

    // A conjoined local Skill Gym occupies the open west annex. Its generous
    // portal keeps the room visually connected and gives returning bots a clear
    // path home whenever live pipeline work begins.
    const gymCenterX = -18.25;
    const gymCenterZ = -0.25;
    const gymPulseMats: THREE.MeshBasicMaterial[] = [];
    const gymRings: THREE.Mesh[] = [];
    const gymDummies: THREE.Group[] = [];

    addBox([8.5, 0.18, 11.4], [gymCenterX, FLOOR_Y - 0.1, gymCenterZ], gymFloorMat);
    addBox([6.8, 0.028, 9.1], [gymCenterX - 0.1, FLOOR_Y + 0.012, gymCenterZ], softMat);
    addBox([0.18, 4.4, 11.4], [-22.5, 0.2, gymCenterZ], wallMat);
    addBox([8.5, 3.1, 0.18], [gymCenterX, -0.42, -5.95], wallMat);
    addBox([8.5, 3.1, 0.18], [gymCenterX, -0.42, 5.45], wallMat);
    addBox([0.26, 0.34, 8.35], [-14.02, 2.55, gymCenterZ], frameMat);
    addBox([0.34, 4.45, 0.34], [-14.02, 0.22, -4.35], frameMat);
    addBox([0.34, 4.45, 0.34], [-14.02, 0.22, 3.85], frameMat);
    addBox([1.3, 0.035, 8.15], [-14.62, FLOOR_Y + 0.025, gymCenterZ], gymInlayMat);

    for (const beamX of [-21.5, -19.4, -17.3, -15.2]) {
      addBox([0.13, 0.12, 10.7], [beamX, 4.62, gymCenterZ], frameMat);
    }
    for (const z of [-3.25, 0, 3.25]) {
      addBox([6.8, 0.035, 0.08], [gymCenterX - 0.05, FLOOR_Y + 0.025, z], gymInlayMat);
      for (const x of [-20.75, -18.65, -16.55]) {
        const laneLightMat = gymGlowMat.clone();
        laneLightMat.opacity = 0.11;
        gymPulseMats.push(laneLightMat);
        const laneLight = new THREE.Mesh(
          new THREE.CircleGeometry(0.08, 16),
          laneLightMat
        );
        laneLight.rotation.x = -Math.PI / 2;
        laneLight.position.set(x, FLOOR_Y + 0.05, z);
        office.add(laneLight);
      }
    }

    const gymSign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.8, 1.28),
      new THREE.MeshBasicMaterial({
        map: makeGymSignTexture(),
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      })
    );
    gymSign.position.set(-22.36, 1.75, gymCenterZ);
    gymSign.rotation.y = Math.PI / 2;
    office.add(gymSign);

    // Three role stations mix physical calibration rigs with a quiet skill
    // forge. They animate only as status indicators, never as hidden network work.
    const gymStationColors = [0xe8a838, 0x4ea8de, 0x7ce88a];
    [-3.25, 0, 3.25].forEach((z, stationIndex) => {
      const stationColor = new THREE.Color(gymStationColors[stationIndex]);
      const stationMat = new THREE.MeshBasicMaterial({
        color: stationColor,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      gymPulseMats.push(stationMat);

      const pad = new THREE.Mesh(
        new THREE.RingGeometry(0.72, 1.02, 44),
        stationMat
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(-18.35, FLOOR_Y + 0.04, z);
      office.add(pad);

      addBox([1.2, 0.16, 0.5], [-20.85, FLOOR_Y + 0.42, z], woodMat);
      addBox([0.12, 0.72, 0.12], [-21.28, FLOOR_Y + 0.36, z], frameMat);
      addBox([0.12, 0.72, 0.12], [-20.42, FLOOR_Y + 0.36, z], frameMat);
      const drillScreen = new THREE.Mesh(
        new THREE.PlaneGeometry(0.95, 0.48),
        stationMat
      );
      drillScreen.position.set(-20.85, FLOOR_Y + 1.05, z);
      drillScreen.rotation.y = Math.PI / 2;
      office.add(drillScreen);

      const hoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.026, 8, 46),
        stationMat
      );
      hoop.position.set(-16.5, FLOOR_Y + 1.25, z);
      hoop.rotation.y = Math.PI / 2;
      hoop.userData.phase = stationIndex * 1.7;
      office.add(hoop);
      gymRings.push(hoop);

      const dummy = new THREE.Group();
      dummy.position.set(-17.35, FLOOR_Y, z);
      office.add(dummy);
      const dummyCore = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.2, 1.25, 12),
        darkMetalMat
      );
      dummyCore.position.y = 0.82;
      dummy.add(dummyCore);
      const dummyHead = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.22, 0),
        stationMat
      );
      dummyHead.position.y = 1.62;
      dummy.add(dummyHead);
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035, 0.05, 0.72, 8),
          frameMat
        );
        arm.position.set(side * 0.28, 1.0, 0);
        arm.rotation.z = side * 0.45;
        dummy.add(arm);
      }
      dummy.userData.phase = stationIndex * 1.4;
      gymDummies.push(dummy);
    });

    const skillForge = new THREE.Group();
    skillForge.position.set(-20.25, FLOOR_Y, gymCenterZ);
    office.add(skillForge);
    const forgeBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.52, 0.7, 0.58, 20),
      darkMetalMat
    );
    forgeBase.position.y = 0.29;
    skillForge.add(forgeBase);
    const forgeCore = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.34, 1),
      gymGlowMat
    );
    forgeCore.position.y = 1.12;
    skillForge.add(forgeCore);
    gymRings.push(forgeCore);
    for (let ringIndex = 0; ringIndex < 3; ringIndex++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.5 + ringIndex * 0.17, 0.018, 7, 40),
        gymGlowMat
      );
      ring.position.y = 1.12;
      ring.rotation.set(
        Math.PI / 2 + ringIndex * 0.42,
        ringIndex * 0.5,
        ringIndex * 0.28
      );
      skillForge.add(ring);
      gymRings.push(ring);
    }
    const gymLight = new THREE.PointLight(0x72b9aa, lowPower ? 1.5 : 2.4, 7.5, 2);
    gymLight.position.set(-18.4, 3.45, gymCenterZ);
    scene.add(gymLight);

    // Layered floor construction: inset runners, thresholds, and hardware make
    // the room feel built rather than like a single floating plane. The wider
    // inset marks a clear collaboration commons between the three team bays.
    addBox([0.16, 0.035, 15.8], [-8.75, FLOOR_Y + 0.012, -0.4], floorInlayMat);
    addBox([0.16, 0.035, 15.8], [8.75, FLOOR_Y + 0.012, -0.4], floorInlayMat);
    addBox([17.6, 0.04, 0.12], [0, FLOOR_Y + 0.022, 3.38], floorInlayMat);
    addBox([17.6, 0.04, 0.12], [0, FLOOR_Y + 0.022, -3.35], floorInlayMat);
    for (const aisleX of [-2.6, 2.6]) {
      addBox([0.07, 0.03, 6.55], [aisleX, FLOOR_Y + 0.022, 0], floorInlayMat);
    }
    for (let bolt = 0; bolt < 26; bolt++) {
      const side = bolt % 2 === 0 ? -1 : 1;
      const fastener = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.018, 10),
        brassMat
      );
      fastener.position.set(
        side * 8.75,
        FLOOR_Y + 0.055,
        -7.7 + Math.floor(bolt / 2) * 1.22
      );
      office.add(fastener);
    }

    // A ribbed ceiling canopy and recessed luminaires establish the studio as
    // an architectural volume even when the camera orbits upward.
    for (let beam = -12.6; beam <= 12.6; beam += 2.1) {
      addBox([0.14, 0.12, 15.6], [beam, 5.12, -0.45], frameMat);
    }
    for (const x of [-10.5, -3.5, 3.5, 10.5]) {
      for (const z of [-4.85, 1.85]) {
        addBox([1.35, 0.08, 0.68], [x, 5.03, z], darkMetalMat);
        addBox([1.05, 0.025, 0.4], [x, 4.98, z], amberGlowMat);
      }
    }

    const grid = new THREE.GridHelper(36, 36, 0x35506a, 0x172532);
    grid.position.y = FLOOR_Y + 0.035;
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.17;
    office.add(grid);

    // Panoramic rear window and structural frame.
    const windowPane = new THREE.Mesh(
      new THREE.PlaneGeometry(27.2, 7.2),
      new THREE.MeshBasicMaterial({
        color: 0x172334,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    windowPane.position.set(0, 1.55, -8.78);
    office.add(windowPane);
    addBox([27.5, 0.15, 0.18], [0, 5.2, -8.74], frameMat);
    addBox([27.5, 0.18, 0.22], [0, FLOOR_Y + 0.12, -8.74], frameMat);
    for (let x = -13.6; x <= 13.6; x += 3.4) {
      addBox([0.11, 7.15, 0.16], [x, 1.55, -8.74], frameMat);
      addBox([0.06, 0.07, 15.8], [x, 5.12, -0.45], frameMat);
    }
    addBox([27.1, 0.24, 0.48], [0, FLOOR_Y + 0.3, -8.5], darkMetalMat);
    addBox([26.7, 0.06, 0.1], [0, 0.1, -8.25], brassMat);
    for (let x = -12.8; x <= 12.8; x += 1.6) {
      addBox([0.035, 1.9, 0.05], [x, -0.85, -8.22], brassMat);
    }

    // Rear service catwalk, under-window storage, and hydroponic troughs turn
    // the panoramic edge into a functional part of the studio.
    addBox([26.4, 0.11, 1.15], [0, FLOOR_Y + 0.2, -7.92], darkMetalMat);
    addBox([26.2, 0.04, 0.06], [0, FLOOR_Y + 0.28, -7.36], brassMat);
    for (let bay = 0; bay < 13; bay++) {
      const bayX = -12 + bay * 2;
      addBox([1.7, 0.62, 0.52], [bayX, FLOOR_Y + 0.58, -8.25], frameMat);
      addBox([1.42, 0.035, 0.02], [bayX, FLOOR_Y + 0.67, -7.98], brassMat);
      if (bay % 2 === 0) {
        const trough = new THREE.Mesh(
          new THREE.BoxGeometry(1.28, 0.24, 0.42),
          woodMat
        );
        trough.position.set(bayX, FLOOR_Y + 0.98, -7.9);
        office.add(trough);
        for (let sprout = 0; sprout < 5; sprout++) {
          const leaf = new THREE.Mesh(
            new THREE.IcosahedronGeometry(0.1 + (sprout % 2) * 0.025, 0),
            plantMat
          );
          leaf.scale.set(1.25, 0.6, 0.78);
          leaf.position.set(
            bayX - 0.48 + sprout * 0.24,
            FLOOR_Y + 1.18 + (sprout % 2) * 0.08,
            -7.9
          );
          office.add(leaf);
        }
      }
    }

    // Ceiling utility spines carry power and data over the three team bays.
    for (const x of agentX) {
      addBox([2.55, 0.1, 0.2], [x, 4.72, -2.15], darkMetalMat);
      addBox([0.06, 0.06, 5.5], [x - 0.64, 4.66, -0.7], brassMat);
      addBox([0.06, 0.06, 5.5], [x + 0.64, 4.66, -0.7], brassMat);
      for (const side of [-1, 1]) {
        const cable = new THREE.Mesh(
          new THREE.TorusGeometry(0.34, 0.015, 6, 30, Math.PI),
          side === -1 ? frameMat : brassMat
        );
        cable.position.set(x + side * 0.6, 4.42, -2.15);
        cable.rotation.set(Math.PI / 2, 0, side * Math.PI / 2);
        office.add(cable);
      }
    }

    // Distant city and a warm planet keep the view expansive without crowding the UI.
    const horizonGlow = new THREE.Mesh(
      new THREE.CircleGeometry(4.6, 48),
      new THREE.MeshBasicMaterial({
        color: 0xd8895c,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    horizonGlow.position.set(-5.2, 1.2, -25);
    scene.add(horizonGlow);
    const planetRing = new THREE.Mesh(
      new THREE.RingGeometry(5.25, 5.38, 96),
      new THREE.MeshBasicMaterial({
        color: 0xc6997a,
        transparent: true,
        opacity: 0.09,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    planetRing.position.copy(horizonGlow.position);
    planetRing.rotation.set(0.18, -0.34, 0.48);
    scene.add(planetRing);
    const distantMoon = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.72, 2),
      new THREE.MeshStandardMaterial({
        color: 0x5f6f82,
        roughness: 1,
        metalness: 0,
        emissive: 0x18202b,
        emissiveIntensity: 0.25,
      })
    );
    distantMoon.position.set(10.5, 5.2, -31);
    scene.add(distantMoon);

    const skyline = new THREE.Group();
    scene.add(skyline);
    const cityMat = new THREE.MeshBasicMaterial({ color: 0x111b28 });
    const cityLightMat = new THREE.MeshBasicMaterial({
      color: 0xd29a65,
      transparent: true,
      opacity: 0.34,
    });
    for (let i = 0; i < 15; i++) {
      const x = -12 + i * 1.72;
      const height = 1.1 + ((i * 7) % 9) * 0.28;
      const z = -11.5 - (i % 3) * 0.5;
      addBox([1.15, height, 0.8], [x, FLOOR_Y + height / 2, z], cityMat, skyline);
      addBox(
        [0.15, Math.max(0.24, height * 0.42), 0.025],
        [x - 0.28, FLOOR_Y + height * 0.62, z + 0.415],
        cityLightMat,
        skyline
      );
      addBox(
        [0.1, Math.max(0.2, height * 0.28), 0.025],
        [x + 0.25, FLOOR_Y + height * 0.5, z + 0.415],
        cityLightMat,
        skyline
      );
    }

    // Exterior transit lights pass behind the glass at three depths. They add
    // scale and life without becoming foreground UI noise.
    const trafficLights: THREE.Mesh[] = [];
    if (!lowPower) {
      for (let lane = 0; lane < 3; lane++) {
        for (let craft = 0; craft < 4; craft++) {
          const traffic = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.018, 0.22, 3, 6),
            new THREE.MeshBasicMaterial({
              color: lane === 1 ? 0x7bb7d9 : 0xe5aa72,
              transparent: true,
              opacity: 0.42 - lane * 0.07,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            })
          );
          traffic.rotation.z = Math.PI / 2;
          traffic.position.set(
            -14 + craft * 7.1 + lane * 1.2,
            -0.2 + lane * 1.25,
            -13.5 - lane * 3.5
          );
          traffic.userData.lane = lane;
          traffic.userData.speed = 0.45 + lane * 0.16 + craft * 0.025;
          trafficLights.push(traffic);
          scene.add(traffic);
        }
      }
    }

    const starGeo = new THREE.BufferGeometry();
    const starCount = lowPower ? 480 : 900;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 28 + Math.random() * 42;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.7 - 4;
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x8fb4ff,
      size: 0.07,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // A floor inlay makes the pipeline order readable even when agents roam.
    const railGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(agentX[0] - 1.2, FLOOR_Y + 0.055, 0),
      new THREE.Vector3(agentX[2] + 1.2, FLOOR_Y + 0.055, 0),
    ]);
    const railMat = new THREE.LineBasicMaterial({
      color: 0x6c86a6,
      transparent: true,
      opacity: 0.28,
    });
    office.add(new THREE.Line(railGeo, railMat));

    // Standing workstations with warm task lights and status-aware holo screens.
    const workstationScreens: THREE.MeshBasicMaterial[] = [];
    const supportScreenMats: Array<{
      mat: THREE.MeshBasicMaterial;
      parentIndex: number;
      supportIndex: number;
    }> = [];
    const teamBeaconMats: THREE.MeshBasicMaterial[] = [];
    const ambientNotes: THREE.Mesh[] = [];
    const ambientNoteMats: THREE.MeshBasicMaterial[] = [];
    const steamWisps: THREE.Mesh[] = [];
    const ceramicMat = new THREE.MeshStandardMaterial({
      color: 0x8c6c51,
      metalness: 0.03,
      roughness: 0.76,
    });
    agentX.forEach((x, i) => {
      addBox([2.45, 0.14, 0.82], [x, FLOOR_Y + 0.72, 1.02], woodMat);
      addBox([0.12, 0.72, 0.12], [x - 0.95, FLOOR_Y + 0.36, 1.02], frameMat);
      addBox([0.12, 0.72, 0.12], [x + 0.95, FLOOR_Y + 0.36, 1.02], frameMat);
      addBox([2.02, 0.08, 0.08], [x, FLOOR_Y + 0.18, 1.02], brassMat);
      addBox([0.62, 0.28, 0.58], [x - 0.68, FLOOR_Y + 0.52, 1.0], darkMetalMat);

      const screenMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(propsRef.current.agents[i]?.color ?? "#7fa7ff"),
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.58), screenMat);
      screen.position.set(x, FLOOR_Y + 1.08, 0.74);
      screen.rotation.x = -0.68;
      office.add(screen);
      workstationScreens.push(screenMat);
      addBox([1.62, 0.055, 0.055], [x, FLOOR_Y + 1.29, 0.58], frameMat);
      addBox([0.055, 0.62, 0.055], [x - 0.8, FLOOR_Y + 1.04, 0.58], frameMat);
      addBox([0.055, 0.62, 0.055], [x + 0.8, FLOOR_Y + 1.04, 0.58], frameMat);
      addBox([0.05, 0.42, 0.05], [x, FLOOR_Y + 0.91, 0.68], brassMat);
      addBox([0.64, 0.035, 0.2], [x, FLOOR_Y + 0.82, 1.18], darkMetalMat);
      for (let key = 0; key < 7; key++) {
        addBox(
          [0.055, 0.018, 0.035],
          [x - 0.21 + key * 0.07, FLOOR_Y + 0.845, 1.16],
          amberGlowMat
        );
      }

      // Floating note tiles make each desk feel actively inhabited.
      for (let noteIndex = 0; noteIndex < 3; noteIndex++) {
        const noteMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(propsRef.current.agents[i]?.color ?? "#7fa7ff"),
          transparent: true,
          opacity: 0.045,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const note = new THREE.Mesh(
          new THREE.PlaneGeometry(0.48 + noteIndex * 0.08, 0.2),
          noteMat
        );
        note.position.set(
          x - 0.76 + noteIndex * 0.76,
          FLOOR_Y + 1.78 + (noteIndex % 2) * 0.26,
          -0.88
        );
        note.rotation.y = (noteIndex - 1) * 0.16;
        note.userData.baseY = note.position.y;
        note.userData.phase = i * 1.9 + noteIndex * 0.8;
        office.add(note);
        ambientNotes.push(note);
        ambientNoteMats.push(noteMat);
      }

      // A small mug is a deliberately human detail in the otherwise synthetic studio.
      const mug = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.09, 0.22, 14),
        ceramicMat
      );
      mug.position.set(x + 0.78, FLOOR_Y + 0.9, 1.02);
      office.add(mug);
      const mugHandle = new THREE.Mesh(
        new THREE.TorusGeometry(0.08, 0.018, 6, 16, Math.PI * 1.55),
        ceramicMat
      );
      mugHandle.position.set(x + 0.89, FLOOR_Y + 0.91, 1.02);
      mugHandle.rotation.y = Math.PI / 2;
      office.add(mugHandle);
      if (!lowPower) {
        for (let wispIndex = 0; wispIndex < 2; wispIndex++) {
          const steamMat = new THREE.MeshBasicMaterial({
            color: 0xb9c6c9,
            transparent: true,
            opacity: 0.08,
            side: THREE.DoubleSide,
            depthWrite: false,
          });
          const steam = new THREE.Mesh(
            new THREE.TorusGeometry(0.055 + wispIndex * 0.018, 0.006, 5, 18, Math.PI),
            steamMat
          );
          steam.position.set(
            x + 0.78 + wispIndex * 0.025,
            FLOOR_Y + 1.08 + wispIndex * 0.12,
            1.02
          );
          steam.rotation.z = Math.PI / 2;
          steam.userData.baseY = steam.position.y;
          steam.userData.phase = i * 1.7 + wispIndex * 0.9;
          office.add(steam);
          steamWisps.push(steam);
        }
      }

      // A compact perch and foot ring give each workstation believable use.
      const stool = new THREE.Group();
      stool.position.set(x + (i - 1) * 0.22, FLOOR_Y, 1.95);
      office.add(stool);
      const stoolSeat = new THREE.Mesh(
        new THREE.CylinderGeometry(0.38, 0.34, 0.16, 20),
        i === 1 ? warmFabricMat : softMat
      );
      stoolSeat.position.y = 0.68;
      stool.add(stoolSeat);
      const stoolStem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.08, 0.64, 10),
        darkMetalMat
      );
      stoolStem.position.y = 0.33;
      stool.add(stoolStem);
      const stoolFoot = new THREE.Mesh(
        new THREE.TorusGeometry(0.28, 0.025, 8, 28),
        brassMat
      );
      stoolFoot.rotation.x = Math.PI / 2;
      stoolFoot.position.y = 0.2;
      stool.add(stoolFoot);
      for (let leg = 0; leg < 4; leg++) {
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(0.34, 0.035, 0.035),
          darkMetalMat
        );
        spoke.position.set(Math.cos(leg * Math.PI / 2) * 0.18, 0.05, Math.sin(leg * Math.PI / 2) * 0.18);
        spoke.rotation.y = -leg * Math.PI / 2;
        stool.add(spoke);
      }

      addBox([1.55, 0.025, 0.025], [x, FLOOR_Y + 1.3, 0.57], amberGlowMat);
      const taskLight = new THREE.PointLight(0xffb86f, lowPower ? 2.2 : 3.4, 4.5, 2);
      taskLight.position.set(x, 2.85, 0.5);
      scene.add(taskLight);
      const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.22, 0.28, 18, 1, true),
        woodMat
      );
      shade.position.set(x, 3.18, 0.5);
      office.add(shade);
      addBox([0.75, 0.035, 0.12], [x, 3.03, 0.5], amberGlowMat);
    });

    // Each lead owns a small team neighborhood behind the primary desk. Two
    // satellite consoles, a shared relay mast, and a floor boundary make the
    // delegation hierarchy legible from the default camera.
    agentX.forEach((x, parentIndex) => {
      const teamColor = new THREE.Color(
        propsRef.current.agents[parentIndex]?.color ?? "#7fa7ff"
      );
      const zoneMat = new THREE.MeshBasicMaterial({
        color: teamColor,
        transparent: true,
        opacity: 0.035,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const zone = new THREE.Mesh(new THREE.CircleGeometry(2.05, 48), zoneMat);
      zone.scale.set(1.08, 0.88, 1);
      zone.rotation.x = -Math.PI / 2;
      zone.position.set(x, FLOOR_Y + 0.025, -1.88);
      office.add(zone);
      const boundary = new THREE.Mesh(
        new THREE.RingGeometry(1.9, 1.95, 56),
        new THREE.MeshBasicMaterial({
          color: teamColor,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      boundary.scale.set(1.08, 0.88, 1);
      boundary.rotation.x = -Math.PI / 2;
      boundary.position.copy(zone.position);
      office.add(boundary);

      const beaconMat = new THREE.MeshBasicMaterial({
        color: teamColor,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      teamBeaconMats.push(beaconMat);
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 2.15, 8),
        beaconMat
      );
      beacon.position.set(x, FLOOR_Y + 1.4, -3.55);
      office.add(beacon);
      const crown = new THREE.Mesh(
        new THREE.TorusGeometry(0.34, 0.014, 7, 36),
        beaconMat
      );
      crown.rotation.x = Math.PI / 2;
      crown.position.set(x, FLOOR_Y + 2.45, -3.55);
      office.add(crown);

      for (let supportIndex = 0; supportIndex < 2; supportIndex++) {
        const supportHome = supportHomes[parentIndex * 2 + supportIndex];
        const side = supportIndex === 0 ? -1 : 1;
        const consoleRoot = new THREE.Group();
        consoleRoot.position.set(
          supportHome.x + side * 0.1,
          FLOOR_Y,
          -1.28
        );
        consoleRoot.rotation.y = side * -0.18;
        office.add(consoleRoot);

        const consoleBase = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.32, 0.52, 14),
          darkMetalMat
        );
        consoleBase.position.y = 0.26;
        consoleRoot.add(consoleBase);
        const consoleShelf = new THREE.Mesh(
          new THREE.BoxGeometry(0.72, 0.08, 0.38),
          woodMat
        );
        consoleShelf.position.y = 0.57;
        consoleRoot.add(consoleShelf);
        const supportScreenMat = new THREE.MeshBasicMaterial({
          color: teamColor.clone().lerp(
            new THREE.Color(supportIndex === 0 ? 0xd4e4d4 : 0xe0c6a3),
            0.18
          ),
          transparent: true,
          opacity: 0.05,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const supportScreen = new THREE.Mesh(
          new THREE.PlaneGeometry(0.66, 0.4),
          supportScreenMat
        );
        supportScreen.position.set(0, 0.84, -0.04);
        supportScreen.rotation.x = -0.42;
        consoleRoot.add(supportScreen);
        supportScreenMats.push({
          mat: supportScreenMat,
          parentIndex,
          supportIndex,
        });
        for (let datum = 0; datum < 4; datum++) {
          const datumBar = new THREE.Mesh(
            new THREE.BoxGeometry(0.08 + datum * 0.04, 0.012, 0.018),
            beaconMat
          );
          datumBar.position.set(
            -0.18 + datum * 0.1,
            0.62,
            0.08
          );
          consoleRoot.add(datumBar);
        }
      }

      // Low storage and a tactile team bench fill the space between support pods.
      addBox([1.36, 0.42, 0.46], [x, FLOOR_Y + 0.21, -3.58], frameMat);
      addBox([1.18, 0.035, 0.03], [x, FLOOR_Y + 0.31, -3.33], beaconMat);
      for (const side of [-1, 1]) {
        addBox(
          [0.34, 0.18, 0.38],
          [x + side * 0.64, FLOOR_Y + 0.57, -3.56],
          side === -1 ? softMat : warmFabricMat
        );
      }
    });

    // Shelving and data volumes on the left.
    const archiveShelfX = -11.1;
    const archiveShelfZ = -5.85;
    addBox([2.25, 0.16, 0.5], [archiveShelfX, FLOOR_Y + 0.25, archiveShelfZ], woodMat);
    addBox([0.14, 3.2, 0.55], [archiveShelfX - 1, FLOOR_Y + 1.7, archiveShelfZ], frameMat);
    addBox([0.14, 3.2, 0.55], [archiveShelfX + 1, FLOOR_Y + 1.7, archiveShelfZ], frameMat);
    for (let level = 0; level < 4; level++) {
      const y = FLOOR_Y + 0.45 + level * 0.78;
      addBox([2.15, 0.1, 0.58], [archiveShelfX, y, archiveShelfZ], woodMat);
      for (let item = 0; item < 4; item++) {
        const slab = addBox(
          [0.22 + (item % 2) * 0.08, 0.42 + ((item + level) % 2) * 0.1, 0.18],
          [archiveShelfX - 0.67 + item * 0.43, y + 0.28, archiveShelfZ + 0.32],
          new THREE.MeshStandardMaterial({
            color: [0x426b72, 0x6b506f, 0x8a633d, 0x4f607a][(item + level) % 4],
            roughness: 0.82,
          })
        );
        slab.rotation.z = (item - 1.5) * 0.018;
      }
    }
    addBox([2.55, 0.055, 0.055], [archiveShelfX, FLOOR_Y + 3.52, archiveShelfZ + 0.4], brassMat);
    const archiveLadder = new THREE.Group();
    archiveLadder.position.set(archiveShelfX + 0.6, FLOOR_Y + 1.62, archiveShelfZ + 0.62);
    archiveLadder.rotation.z = -0.09;
    office.add(archiveLadder);
    for (const x of [-0.24, 0.24]) {
      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 2.85, 8),
        brassMat
      );
      rail.position.x = x;
      archiveLadder.add(rail);
    }
    for (let rung = -1.15; rung <= 1.15; rung += 0.38) {
      const cross = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 0.48, 8),
        brassMat
      );
      cross.rotation.z = Math.PI / 2;
      cross.position.y = rung;
      archiveLadder.add(cross);
    }
    const shelfCrystal = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.21, 0),
      glassMat
    );
    shelfCrystal.position.set(archiveShelfX - 0.47, FLOOR_Y + 3.55, archiveShelfZ + 0.34);
    shelfCrystal.rotation.set(0.2, 0.4, 0.1);
    office.add(shelfCrystal);

    // The existing archive is a real entry point to the shared local library.
    const libraryHitBox = new THREE.Mesh(new THREE.BoxGeometry(2.4, 3.7, 0.9),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    libraryHitBox.position.set(archiveShelfX, FLOOR_Y + 1.9, archiveShelfZ + 0.25);
    libraryHitBox.userData.library = true;
    office.add(libraryHitBox);
    const libraryCanvas = document.createElement("canvas");
    libraryCanvas.width = 512; libraryCanvas.height = 112;
    const libraryContext = libraryCanvas.getContext("2d");
    if (libraryContext) {
      libraryContext.fillStyle = "#242b2b"; libraryContext.fillRect(0, 0, 512, 112);
      libraryContext.fillStyle = "#dfc89a"; libraryContext.font = "600 39px sans-serif";
      libraryContext.textAlign = "center"; libraryContext.fillText("KNOWLEDGE LIBRARY", 256, 70);
    }
    const librarySign = new THREE.Mesh(new THREE.PlaneGeometry(2.65, 0.58),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(libraryCanvas), side: THREE.DoubleSide }));
    librarySign.position.set(archiveShelfX, FLOOR_Y + 3.98, archiveShelfZ + 0.45);
    librarySign.userData.library = true;
    office.add(librarySign);

    // A quiet lounge and a small coffee table live at the office edge.
    const loungeX = 10.55;
    const loungeZ = 3.35;
    addBox([4.8, 0.035, 3.1], [loungeX - 0.45, FLOOR_Y + 0.028, loungeZ - 0.55], woodMat);
    addRoundedBox(
      [2.7, 0.42, 0.95],
      [loungeX, FLOOR_Y + 0.42, loungeZ],
      softMat,
      0.16
    );
    const sofaBack = addRoundedBox(
      [2.7, 1.05, 0.32],
      [loungeX, FLOOR_Y + 0.92, loungeZ + 0.38],
      softMat,
      0.14
    );
    sofaBack.rotation.x = -0.12;
    addRoundedBox(
      [0.34, 0.68, 1.05],
      [loungeX - 1.5, FLOOR_Y + 0.55, loungeZ + 0.02],
      softMat,
      0.14
    );
    addRoundedBox(
      [0.34, 0.68, 1.05],
      [loungeX + 1.5, FLOOR_Y + 0.55, loungeZ + 0.02],
      softMat,
      0.14
    );
    addRoundedBox(
      [1.55, 0.12, 0.8],
      [loungeX - 1.1, FLOOR_Y + 0.52, loungeZ - 1.55],
      woodMat,
      0.06
    );
    addBox([0.11, 0.5, 0.11], [loungeX - 1.65, FLOOR_Y + 0.26, loungeZ - 1.55], frameMat);
    addBox([0.11, 0.5, 0.11], [loungeX - 0.55, FLOOR_Y + 0.26, loungeZ - 1.55], frameMat);
    const cushionA = addRoundedBox(
      [0.68, 0.18, 0.62],
      [loungeX - 0.47, FLOOR_Y + 0.72, loungeZ - 0.08],
      warmFabricMat,
      0.09
    );
    cushionA.rotation.z = -0.08;
    const cushionB = addRoundedBox(
      [0.64, 0.2, 0.58],
      [loungeX + 0.55, FLOOR_Y + 0.72, loungeZ - 0.06],
      paperMat,
      0.09
    );
    cushionB.rotation.z = 0.07;
    const tableBook = addRoundedBox(
      [0.48, 0.06, 0.62],
      [loungeX - 1.3, FLOOR_Y + 0.61, loungeZ - 1.6],
      paperMat,
      0.025
    );
    tableBook.rotation.y = -0.12;
    const carafe = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.15, 0.34, 16),
      glassMat
    );
    carafe.position.set(loungeX - 0.83, FLOOR_Y + 0.73, loungeZ - 1.5);
    office.add(carafe);
    const loungeLamp = new THREE.Group();
    loungeLamp.position.set(loungeX + 1.55, FLOOR_Y, loungeZ - 1.55);
    office.add(loungeLamp);
    const lampStem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.04, 2.35, 8),
      brassMat
    );
    lampStem.position.y = 1.18;
    loungeLamp.add(lampStem);
    const lampBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.36, 0.08, 20),
      darkMetalMat
    );
    lampBase.position.y = 0.04;
    loungeLamp.add(lampBase);
    const lampShade = new THREE.Mesh(
      new THREE.CylinderGeometry(0.27, 0.48, 0.52, 20, 1, true),
      warmFabricMat
    );
    lampShade.position.y = 2.22;
    loungeLamp.add(lampShade);
    const lampGlow = new THREE.PointLight(0xffb980, lowPower ? 1.5 : 2.6, 3.6, 2);
    lampGlow.position.set(loungeX + 1.55, FLOOR_Y + 2.15, loungeZ - 1.55);
    scene.add(lampGlow);

    const addPlant = (x: number, z: number, scale: number) => {
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34 * scale, 0.25 * scale, 0.5 * scale, 14),
        woodMat
      );
      pot.position.set(x, FLOOR_Y + 0.25 * scale, z);
      office.add(pot);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035 * scale, 0.05 * scale, 1.15 * scale, 8),
        plantMat
      );
      stem.position.set(x, FLOOR_Y + 0.92 * scale, z);
      office.add(stem);
      for (let leaf = 0; leaf < 5; leaf++) {
        const crown = new THREE.Mesh(
          new THREE.IcosahedronGeometry((0.28 + (leaf % 2) * 0.08) * scale, 0),
          plantMat
        );
        crown.position.set(
          x + Math.sin(leaf * 2.4) * 0.28 * scale,
          FLOOR_Y + (1.15 + leaf * 0.12) * scale,
          z + Math.cos(leaf * 2.4) * 0.24 * scale
        );
        crown.scale.set(1.35, 0.7, 0.9);
        office.add(crown);
      }
    };
    addPlant(-11.7, 3.55, 1.08);
    addPlant(11.75, -6.65, 1.2);

    // Shared projection table in the midground. Its quiet celestial model gives
    // the agents somewhere to gather without competing with task-state effects.
    const projectionTable = new THREE.Group();
    projectionTable.position.set(10, FLOOR_Y, -4.95);
    office.add(projectionTable);
    const projectionBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.58, 0.68, 18),
      darkMetalMat
    );
    projectionBase.position.y = 0.34;
    projectionTable.add(projectionBase);
    const projectionTop = new THREE.Mesh(
      new THREE.CylinderGeometry(1.05, 0.92, 0.12, 28),
      woodMat
    );
    projectionTop.position.y = 0.74;
    projectionTable.add(projectionTop);
    const projectionCore = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 2),
      new THREE.MeshBasicMaterial({
        color: 0x7db3c9,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        wireframe: true,
        depthWrite: false,
      })
    );
    projectionCore.position.y = 1.42;
    projectionTable.add(projectionCore);
    const projectionRings: THREE.Mesh[] = [];
    for (let ringIndex = 0; ringIndex < 3; ringIndex++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.48 + ringIndex * 0.16, 0.012, 7, 48),
        new THREE.MeshBasicMaterial({
          color: ringIndex === 1 ? 0xe0a565 : 0x719eb8,
          transparent: true,
          opacity: 0.1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      ring.position.y = 1.42;
      ring.rotation.set(
        Math.PI / 2 + ringIndex * 0.36,
        ringIndex * 0.42,
        ringIndex * 0.24
      );
      projectionTable.add(ring);
      projectionRings.push(ring);
    }
    const sideConsoleX = 13.82;
    const sideConsoleZ = -2.65;
    addBox([0.08, 2.5, 2.15], [sideConsoleX, 0.0, sideConsoleZ], frameMat);
    const sideConsole = new THREE.Mesh(
      new THREE.PlaneGeometry(1.65, 1.9),
      new THREE.MeshBasicMaterial({
        color: 0x6e91a8,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    sideConsole.position.set(sideConsoleX - 0.11, 0.3, sideConsoleZ);
    sideConsole.rotation.y = -Math.PI / 2;
    office.add(sideConsole);
    for (let readout = 0; readout < 5; readout++) {
      addBox(
        [0.025, 0.035, 1.15 - readout * 0.12],
        [sideConsoleX - 0.15, 0.95 - readout * 0.3, sideConsoleZ],
        readout === 0 ? amberGlowMat : glassMat
      );
    }

    // The memory archive mirrors the connected Obsidian vault as a quiet stack
    // of floating knowledge tiles near the physical shelf.
    const memoryArchive = new THREE.Group();
    memoryArchive.position.set(-9.35, 0.15, -6.55);
    office.add(memoryArchive);
    const archiveBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.9, 0.24, 24),
      darkMetalMat
    );
    archiveBase.position.y = -0.05;
    memoryArchive.add(archiveBase);
    const archiveCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, 1.45, 12),
      glassMat
    );
    archiveCore.position.y = 0.76;
    memoryArchive.add(archiveCore);
    const archiveCards: THREE.Mesh[] = [];
    for (let cardIndex = 0; cardIndex < 5; cardIndex++) {
      const archiveMat = new THREE.MeshBasicMaterial({
        color: cardIndex % 2 === 0 ? 0xe2a55d : 0x7297c8,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const card = new THREE.Mesh(
        new THREE.PlaneGeometry(0.86 - cardIndex * 0.05, 0.32),
        archiveMat
      );
      card.position.set(
        (cardIndex % 2) * 0.18,
        cardIndex * 0.38,
        -cardIndex * 0.06
      );
      card.rotation.y = -0.2 + cardIndex * 0.08;
      card.userData.baseY = card.position.y;
      card.userData.phase = cardIndex * 0.85;
      memoryArchive.add(card);
      archiveCards.push(card);
    }
    const archiveRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.018, 8, 52),
      amberGlowMat
    );
    archiveRing.position.y = 0.78;
    archiveRing.rotation.x = Math.PI / 2;
    memoryArchive.add(archiveRing);

    // A maintenance drone supplies slow background activity.
    const serviceDrone = new THREE.Group();
    const droneCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18),
      new THREE.MeshBasicMaterial({
        color: 0xf0ad68,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
      })
    );
    serviceDrone.add(droneCore);
    const droneRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.018, 8, 40),
      amberGlowMat
    );
    droneRing.rotation.x = Math.PI / 2;
    serviceDrone.add(droneRing);
    const droneEye = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xf8d6a6,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
      })
    );
    droneEye.position.z = 0.17;
    serviceDrone.add(droneEye);
    for (const side of [-1, 1]) {
      const droneArm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.024, 0.42, 7),
        brassMat
      );
      droneArm.rotation.z = side * 1.08;
      droneArm.position.x = side * 0.2;
      serviceDrone.add(droneArm);
      const dronePod = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 10, 8),
        darkMetalMat
      );
      dronePod.position.set(side * 0.38, -0.11, 0);
      serviceDrone.add(dronePod);
    }
    const droneBeam = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.7, 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x83aabd,
        transparent: true,
        opacity: 0.035,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    droneBeam.position.y = -0.48;
    droneBeam.rotation.z = Math.PI;
    serviceDrone.add(droneBeam);
    serviceDrone.position.set(0, 1.65, -6.85);
    office.add(serviceDrone);

    // signature geometries: head + chest core identity per agent
    const sigGeos = [
      new THREE.OctahedronGeometry(1.0),
      new THREE.TetrahedronGeometry(1.1),
      new THREE.IcosahedronGeometry(0.95, 0),
    ];

    // --- Humanoid bot builder ---
    // Root sits on the floor. Proportions: hips 1.08, chest ~1.66, head ~2.2.
    const buildBot = (colorHex: string, sigIdx: number, agentIndex: number) => {
      const color = new THREE.Color(colorHex);

      const solid = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const wire = new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
      });
      const core = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const haloMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shellColor = color.clone().lerp(new THREE.Color(0x34424d), 0.7);
      const shell = new THREE.MeshStandardMaterial({
        color: shellColor,
        emissive: color.clone().multiplyScalar(0.18),
        emissiveIntensity: 0.4,
        metalness: 0.58,
        roughness: 0.3,
        transparent: true,
        opacity: 0.72,
      });
      const joint = new THREE.MeshStandardMaterial({
        color: 0x26323b,
        emissive: color.clone().multiplyScalar(0.08),
        emissiveIntensity: 0.28,
        metalness: 0.82,
        roughness: 0.22,
        transparent: true,
        opacity: 0.88,
      });
      const visor = new THREE.MeshBasicMaterial({
        color: color.clone().lerp(new THREE.Color(0xe8f4f1), 0.42),
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const chestGlow = new THREE.SpriteMaterial({
        map: glowTex,
        color,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const headGlow = new THREE.SpriteMaterial({
        map: glowTex,
        color,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mats: BotMats = {
        solid,
        wire,
        core,
        halo: haloMat,
        shell,
        joint,
        visor,
        chestGlow,
        headGlow,
      };

      const tag = <T extends THREE.Object3D>(m: T): T => {
        m.userData.agentIndex = agentIndex;
        return m;
      };

      // Layered limb with a top pivot. The emissive inner segment preserves the
      // holographic identity while the outer armor gives the body real volume.
      const limb = (len: number, r: number, armorScale = 1.14) => {
        const segment = tag(new THREE.Group());
        const g = new THREE.CylinderGeometry(r * 0.75, r, len, 8);
        g.translate(0, -len / 2, 0);
        segment.add(tag(new THREE.Mesh(g, solid)));
        const armorGeo = new THREE.CylinderGeometry(
          r * 0.78 * armorScale,
          r * armorScale,
          len * 0.72,
          8
        );
        armorGeo.translate(0, -len * 0.4, 0);
        const armor = tag(new THREE.Mesh(armorGeo, shell));
        segment.add(armor);
        return segment;
      };

      const root = new THREE.Group();

      const hips = new THREE.Group();
      hips.position.y = 1.08;
      root.add(hips);
      const hipCore = tag(new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), solid));
      hips.add(hipCore);
      const pelvisShell = tag(
        new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10), shell)
      );
      pelvisShell.scale.set(1.05, 0.58, 0.72);
      pelvisShell.position.y = 0.015;
      hips.add(pelvisShell);
      const waistRing = tag(
        new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.025, 8, 28), visor)
      );
      waistRing.rotation.x = Math.PI / 2;
      waistRing.position.y = 0.19;
      hips.add(waistRing);
      for (const side of [-1, 1]) {
        const hipGuard = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.2), shell)
        );
        hipGuard.position.set(side * 0.24, -0.05, 0);
        hipGuard.rotation.z = side * 0.16;
        hips.add(hipGuard);
      }

      const hipJoints: THREE.Group[] = [];
      const kneeJoints: THREE.Group[] = [];
      const ankleJoints: THREE.Group[] = [];

      // Articulated legs support the patrol walk cycle.
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.18, -0.06, 0);
        hips.add(hip);
        hipJoints.push(hip);
        const hipBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 9), joint)
        );
        hip.add(hipBearing);
        const thigh = limb(0.52, 0.078, 1.28);
        hip.add(thigh);
        const thighPanel = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.28, 0.13), shell)
        );
        thighPanel.position.set(side * 0.025, -0.24, 0.055);
        hip.add(thighPanel);
        const knee = new THREE.Group();
        knee.position.y = -0.52;
        hip.add(knee);
        kneeJoints.push(knee);
        const kneeBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 9), joint)
        );
        knee.add(kneeBearing);
        const kneeCap = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 8), shell)
        );
        kneeCap.scale.set(0.9, 1.05, 0.5);
        kneeCap.position.z = 0.075;
        knee.add(kneeCap);
        const shin = limb(0.5, 0.062, 1.22);
        knee.add(shin);
        const calfPanel = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.28, 0.11), shell)
        );
        calfPanel.position.set(-side * 0.02, -0.25, -0.045);
        knee.add(calfPanel);
        const ankle = new THREE.Group();
        ankle.position.y = -0.5;
        knee.add(ankle);
        ankleJoints.push(ankle);
        const ankleBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), joint)
        );
        ankle.add(ankleBearing);
        const foot = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.075, 0.34), shell)
        );
        foot.position.set(0, -0.045, 0.09);
        ankle.add(foot);
        const sole = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.025, 0.35), joint)
        );
        sole.position.set(0, -0.09, 0.09);
        ankle.add(sole);
        const toeLight = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.018), visor)
        );
        toeLight.position.set(0, -0.04, 0.265);
        ankle.add(toeLight);
      }

      // torso (pivots at hips so it can lean)
      const torso = new THREE.Group();
      hips.add(torso);
      const torsoGeo = new THREE.CylinderGeometry(0.3, 0.17, 0.78, 8);
      const torsoMesh = tag(new THREE.Mesh(torsoGeo, solid));
      torsoMesh.position.y = 0.49;
      torso.add(torsoMesh);
      const torsoWire = tag(new THREE.Mesh(torsoGeo.clone(), wire));
      torsoWire.position.y = 0.49;
      torsoWire.scale.setScalar(1.04);
      torso.add(torsoWire);
      const abdomen = tag(
        new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), shell)
      );
      abdomen.position.y = 0.31;
      abdomen.scale.set(0.86, 1.08, 0.72);
      torso.add(abdomen);
      const chestPlate = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.28, 0.22), shell)
      );
      chestPlate.position.set(0, 0.65, 0.035);
      torso.add(chestPlate);
      const sternum = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.4, 0.045), visor)
      );
      sternum.position.set(0, 0.55, 0.16);
      torso.add(sternum);
      for (const side of [-1, 1]) {
        const clavicle = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.055, 0.08), shell)
        );
        clavicle.position.set(side * 0.15, 0.78, 0.08);
        clavicle.rotation.z = side * -0.16;
        torso.add(clavicle);
      }
      const collar = tag(
        new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.026, 8, 28), joint)
      );
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 0.92;
      torso.add(collar);
      for (let rib = 0; rib < 3; rib++) {
        const ribBand = tag(
          new THREE.Mesh(
            new THREE.TorusGeometry(0.2 + rib * 0.025, 0.009, 6, 30, Math.PI),
            visor
          )
        );
        ribBand.rotation.set(Math.PI / 2, 0, Math.PI / 2);
        ribBand.position.set(0, 0.37 + rib * 0.13, 0.01);
        torso.add(ribBand);
      }
      const spine = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.08), joint)
      );
      spine.position.set(0, 0.53, -0.18);
      torso.add(spine);

      // chest core — the agent's signature polyhedron
      const chestCore = tag(new THREE.Mesh(sigGeos[sigIdx % 3], core));
      chestCore.scale.setScalar(0.145);
      chestCore.position.set(0, 0.62, 0.19);
      torso.add(chestCore);
      const chestGlowSprite = new THREE.Sprite(chestGlow);
      chestGlowSprite.scale.setScalar(1.9);
      chestGlowSprite.position.set(0, 0.62, 0.18);
      torso.add(chestGlowSprite);

      // neck + head
      const neck = tag(
        new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.18, 10), joint)
      );
      neck.position.y = 0.95;
      torso.add(neck);

      const head = new THREE.Group();
      head.position.y = 1.11;
      torso.add(head);
      const helmet = tag(
        new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), shell)
      );
      helmet.scale.set(0.94, 1.14, 0.86);
      head.add(helmet);
      const faceInset = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.17, 0.035), joint)
      );
      faceInset.position.set(0, 0.015, 0.228);
      head.add(faceInset);
      const headMesh = tag(new THREE.Mesh(sigGeos[sigIdx % 3], core));
      headMesh.scale.setScalar(0.115);
      headMesh.position.set(0, 0.16, 0.23);
      head.add(headMesh);
      const headWire = tag(new THREE.Mesh(sigGeos[sigIdx % 3], wire));
      headWire.scale.setScalar(0.16);
      headWire.position.copy(headMesh.position);
      head.add(headWire);
      for (const side of [-1, 1]) {
        const eye = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.035, 0.024), visor)
        );
        eye.position.set(side * 0.078, 0.035, 0.257);
        eye.rotation.z = side * -0.055;
        head.add(eye);
        const temple = tag(
          new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.045, 10), joint)
        );
        temple.rotation.z = Math.PI / 2;
        temple.position.set(side * 0.275, 0.015, 0);
        head.add(temple);
      }
      const jaw = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.07, 0.16), shell)
      );
      jaw.position.set(0, -0.205, 0.055);
      head.add(jaw);
      const chinLight = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.018, 0.018), visor)
      );
      chinLight.position.set(0, -0.23, 0.145);
      head.add(chinLight);
      const crownPanel = tag(
        new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.055, 0.22), shell)
      );
      crownPanel.position.set(0, 0.255, -0.02);
      head.add(crownPanel);
      const headGlowSprite = new THREE.Sprite(headGlow);
      headGlowSprite.scale.setScalar(1.3);
      head.add(headGlowSprite);

      // spinning halo above the head
      const halo = tag(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.012, 8, 48), haloMat));
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.46;
      head.add(halo);
      const antenna = tag(
        new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.2, 7), joint)
      );
      antenna.position.set(agentIndex === 2 ? -0.16 : 0.16, 0.36, -0.02);
      antenna.rotation.z = agentIndex === 2 ? -0.12 : 0.12;
      head.add(antenna);
      const antennaTip = tag(
        new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), visor)
      );
      antennaTip.position.set(agentIndex === 2 ? -0.18 : 0.18, 0.46, -0.02);
      head.add(antennaTip);

      // shoulders + arms
      const shoulderBar = tag(
        new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.78, 10), joint)
      );
      shoulderBar.rotation.z = Math.PI / 2;
      shoulderBar.position.y = 0.86;
      torso.add(shoulderBar);

      const makeArm = (side: number) => {
        const shoulder = new THREE.Group();
        shoulder.position.set(side * 0.45, 0.86, 0);
        torso.add(shoulder);
        const shoulderBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 9), joint)
        );
        shoulder.add(shoulderBearing);
        const shoulderCap = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 9), shell)
        );
        shoulderCap.scale.set(1.2, 0.7, 1);
        shoulderCap.position.set(side * 0.035, -0.035, 0);
        shoulder.add(shoulderCap);
        const upper = limb(0.48, 0.061, agentIndex === 1 ? 1.36 : 1.2);
        shoulder.add(upper);
        const elbow = new THREE.Group();
        elbow.position.y = -0.48;
        shoulder.add(elbow);
        const elbowBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.078, 11, 8), joint)
        );
        elbow.add(elbowBearing);
        const elbowCap = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.11, 0.09), shell)
        );
        elbowCap.position.z = 0.065;
        elbow.add(elbowCap);
        const fore = limb(0.42, 0.052, agentIndex === 1 ? 1.42 : 1.18);
        elbow.add(fore);
        const forearmRail = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.04), visor)
        );
        forearmRail.position.set(side * 0.045, -0.23, 0.065);
        elbow.add(forearmRail);
        const wrist = new THREE.Group();
        wrist.position.y = -0.42;
        elbow.add(wrist);
        const wristBearing = tag(
          new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), joint)
        );
        wrist.add(wristBearing);
        const palm = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.14, 0.06), shell)
        );
        palm.position.y = -0.085;
        wrist.add(palm);
        for (let finger = 0; finger < 3; finger++) {
          const digit = tag(
            new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.12, 6), shell)
          );
          digit.position.set((finger - 1) * 0.032, -0.2, 0.008);
          digit.rotation.z = (finger - 1) * 0.035;
          wrist.add(digit);
        }
        const thumb = tag(
          new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.09, 6), shell)
        );
        thumb.position.set(side * 0.065, -0.12, 0.01);
        thumb.rotation.z = side * 0.62;
        wrist.add(thumb);
        return { shoulder, elbow, wrist };
      };
      const armL = makeArm(-1);
      const armR = makeArm(1);

      // Role-specific armor changes the silhouette at a glance.
      if (agentIndex === 0) {
        for (const side of [-1, 1]) {
          const plannerFin = tag(
            new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.36, 3), shell)
          );
          plannerFin.position.set(side * 0.39, 0.76, -0.13);
          plannerFin.rotation.z = side * -0.5;
          torso.add(plannerFin);
        }
        const strategyCrown = tag(
          new THREE.Mesh(
            new THREE.TorusGeometry(0.36, 0.015, 8, 42, Math.PI * 1.45),
            visor
          )
        );
        strategyCrown.rotation.set(Math.PI / 2, 0, Math.PI * 0.78);
        strategyCrown.position.set(0, 0.22, -0.02);
        head.add(strategyCrown);
        for (let node = -1; node <= 1; node++) {
          const mapNode = tag(
            new THREE.Mesh(new THREE.OctahedronGeometry(0.032, 0), core)
          );
          mapNode.position.set(node * 0.12, 0.33 + Math.abs(node) * 0.03, 0.07);
          head.add(mapNode);
        }
        const planningLens = tag(
          new THREE.Mesh(new THREE.RingGeometry(0.09, 0.14, 28), visor)
        );
        planningLens.rotation.x = -Math.PI / 2;
        planningLens.position.set(0, -0.12, 0.08);
        armL.wrist.add(planningLens);
      } else if (agentIndex === 1) {
        for (const side of [-1, 1]) {
          const builderPack = tag(
            new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.2), shell)
          );
          builderPack.position.set(side * 0.25, 0.53, -0.22);
          torso.add(builderPack);
        }
        const toolLight = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.035), visor)
        );
        toolLight.position.set(0, -0.18, 0.09);
        armR.elbow.add(toolLight);
        const reinforcedSpine = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.62, 0.12), joint)
        );
        reinforcedSpine.position.set(0, 0.5, -0.245);
        torso.add(reinforcedSpine);
        for (let rail = -1; rail <= 1; rail++) {
          const toolRail = tag(
            new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.3, 0.045), visor)
          );
          toolRail.position.set(rail * 0.055, -0.22, 0.08);
          armR.elbow.add(toolRail);
        }
        const builderVisor = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.045, 0.025), visor)
        );
        builderVisor.position.set(0, 0.035, 0.268);
        head.add(builderVisor);
      } else {
        for (const side of [-1, 1]) {
          const editorPanel = tag(
            new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.36, 0.035), shell)
          );
          editorPanel.position.set(side * 0.25, 0.42, 0.17);
          editorPanel.rotation.z = side * 0.08;
          torso.add(editorPanel);
        }
        const reviewLens = tag(
          new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.014, 8, 36), visor)
        );
        reviewLens.position.set(0.105, 0.035, 0.27);
        head.add(reviewLens);
        const lensBridge = tag(
          new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.018, 0.018), joint)
        );
        lensBridge.position.set(0, 0.035, 0.25);
        head.add(lensBridge);
        for (const side of [-1, 1]) {
          const proofFin = tag(
            new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.25, 4), shell)
          );
          proofFin.position.set(side * 0.25, 0.9, -0.08);
          proofFin.rotation.z = side * -0.28;
          torso.add(proofFin);
        }
      }

      const joints: BotJoints = {
        hips,
        torso,
        head,
        halo,
        hipL: hipJoints[0],
        hipR: hipJoints[1],
        kneeL: kneeJoints[0],
        kneeR: kneeJoints[1],
        ankleL: ankleJoints[0],
        ankleR: ankleJoints[1],
        shoulderL: armL.shoulder,
        shoulderR: armR.shoulder,
        elbowL: armL.elbow,
        elbowR: armR.elbow,
        wristL: armL.wrist,
        wristR: armR.wrist,
      };
      return { root, joints, mats };
    };

    // --- Downline specialist builder ---
    // Smaller support humanoids retain clear anatomy but use a compact shell,
    // fewer armor layers, and a single role light so the leads remain dominant.
    const buildSupportBot = (
      colorHex: string,
      parentIndex: number,
      supportIndex: number
    ) => {
      const specialistIndex = parentIndex * 2 + supportIndex;
      const specialistTints = [
        0xa9d8cf,
        0xe6bf7b,
        0x8cc8e8,
        0x9cafd9,
        0x9fe3b0,
        0xd8c69a,
      ];
      const parentColor = new THREE.Color(colorHex);
      const supportColor = parentColor.clone().lerp(
        new THREE.Color(specialistTints[specialistIndex]),
        0.28
      );
      const shellMat = new THREE.MeshStandardMaterial({
        color: supportColor.clone().lerp(new THREE.Color(0x27343e), 0.68),
        emissive: supportColor.clone().multiplyScalar(0.16),
        emissiveIntensity: 0.3,
        metalness: 0.58,
        roughness: 0.34,
        transparent: true,
        opacity: 0.58,
      });
      const glowMat = new THREE.MeshBasicMaterial({
        color: supportColor,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const visorMat = new THREE.MeshBasicMaterial({
        color: supportColor.clone().lerp(new THREE.Color(0xe3eeeb), 0.36),
        transparent: true,
        opacity: 0.66,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const jointMat = new THREE.MeshStandardMaterial({
        color: 0x202c34,
        emissive: supportColor.clone().multiplyScalar(0.06),
        emissiveIntensity: 0.24,
        metalness: 0.82,
        roughness: 0.24,
      });

      const segment = (length: number, radius: number) => {
        const group = new THREE.Group();
        const innerGeo = new THREE.CylinderGeometry(
          radius * 0.68,
          radius,
          length,
          7
        );
        innerGeo.translate(0, -length / 2, 0);
        group.add(new THREE.Mesh(innerGeo, glowMat));
        const shellGeo = new THREE.CylinderGeometry(
          radius * 0.82,
          radius * 1.15,
          length * 0.66,
          7
        );
        shellGeo.translate(0, -length * 0.4, 0);
        group.add(new THREE.Mesh(shellGeo, shellMat));
        return group;
      };

      const root = new THREE.Group();
      const hips = new THREE.Group();
      hips.position.y = 0.66;
      root.add(hips);
      const pelvis = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8),
        shellMat
      );
      pelvis.scale.set(1.12, 0.58, 0.78);
      hips.add(pelvis);
      const hipJoints: THREE.Group[] = [];
      const kneeJoints: THREE.Group[] = [];
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(side * 0.115, -0.03, 0);
        hips.add(hip);
        hipJoints.push(hip);
        hip.add(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), jointMat));
        hip.add(segment(0.31, 0.047));
        const knee = new THREE.Group();
        knee.position.y = -0.31;
        hip.add(knee);
        kneeJoints.push(knee);
        knee.add(new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 6), jointMat));
        knee.add(segment(0.3, 0.041));
        const foot = new THREE.Mesh(
          new THREE.BoxGeometry(0.1, 0.05, 0.22),
          shellMat
        );
        foot.position.set(0, -0.31, 0.055);
        knee.add(foot);
      }

      const torso = new THREE.Group();
      hips.add(torso);
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.12, 0.52, 8),
        shellMat
      );
      body.position.y = 0.33;
      torso.add(body);
      const bodyWire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.205, 0.125, 0.525, 8),
        new THREE.MeshBasicMaterial({
          color: supportColor,
          wireframe: true,
          transparent: true,
          opacity: 0.2,
        })
      );
      bodyWire.position.copy(body.position);
      torso.add(bodyWire);
      const chestCore = new THREE.Mesh(sigGeos[specialistIndex % 3], glowMat);
      chestCore.scale.setScalar(0.075);
      chestCore.position.set(0, 0.38, 0.13);
      torso.add(chestCore);
      const chestBar = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.025, 0.018),
        visorMat
      );
      chestBar.position.set(0, 0.52, 0.14);
      torso.add(chestBar);

      const shoulderJoints: THREE.Group[] = [];
      const elbowJoints: THREE.Group[] = [];
      for (const side of [-1, 1]) {
        const shoulder = new THREE.Group();
        shoulder.position.set(side * 0.27, 0.53, 0);
        torso.add(shoulder);
        shoulderJoints.push(shoulder);
        shoulder.add(
          new THREE.Mesh(new THREE.SphereGeometry(0.064, 9, 7), jointMat)
        );
        shoulder.add(segment(0.28, 0.042));
        const elbow = new THREE.Group();
        elbow.position.y = -0.28;
        shoulder.add(elbow);
        elbowJoints.push(elbow);
        elbow.add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), jointMat));
        elbow.add(segment(0.24, 0.034));
        const hand = new THREE.Mesh(
          new THREE.BoxGeometry(0.065, 0.09, 0.045),
          shellMat
        );
        hand.position.y = -0.27;
        elbow.add(hand);
      }

      const head = new THREE.Group();
      head.position.y = 0.83;
      torso.add(head);
      const helmet = new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 14, 10),
        shellMat
      );
      helmet.scale.set(0.92, 1.1, 0.84);
      head.add(helmet);
      const face = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.09, 0.025),
        jointMat
      );
      face.position.set(0, 0.015, 0.145);
      head.add(face);
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(
          new THREE.BoxGeometry(0.063, 0.025, 0.018),
          visorMat
        );
        eye.position.set(side * 0.047, 0.03, 0.163);
        head.add(eye);
      }
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.2, 0.009, 6, 32),
        glowMat
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.29;
      head.add(halo);
      const roleAntenna = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.012, 0.16, 6),
        jointMat
      );
      roleAntenna.position.set(
        supportIndex === 0 ? -0.11 : 0.11,
        0.24,
        -0.02
      );
      roleAntenna.rotation.z = supportIndex === 0 ? -0.18 : 0.18;
      head.add(roleAntenna);
      const roleLight = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 7, 5),
        visorMat
      );
      roleLight.position.set(
        supportIndex === 0 ? -0.125 : 0.125,
        0.32,
        -0.02
      );
      head.add(roleLight);

      // Six specialist silhouettes: sensor, blueprint, fabrication, bridge,
      // audit, and finishing equipment. Each remains subordinate in scale.
      if (specialistIndex === 0) {
        const sensorDish = new THREE.Mesh(
          new THREE.RingGeometry(0.07, 0.12, 24),
          visorMat
        );
        sensorDish.rotation.y = -0.35;
        sensorDish.position.set(-0.19, 0.1, 0.12);
        head.add(sensorDish);
        const sensorBoom = new THREE.Mesh(
          new THREE.CylinderGeometry(0.009, 0.012, 0.24, 6),
          jointMat
        );
        sensorBoom.rotation.z = -0.65;
        sensorBoom.position.set(-0.15, 0.28, 0);
        head.add(sensorBoom);
      } else if (specialistIndex === 1) {
        for (const side of [-1, 1]) {
          const planFin = new THREE.Mesh(
            new THREE.BoxGeometry(0.055, 0.28, 0.16),
            shellMat
          );
          planFin.position.set(side * 0.18, 0.37, -0.13);
          planFin.rotation.z = side * -0.1;
          torso.add(planFin);
        }
        const datumBar = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.018, 0.018),
          visorMat
        );
        datumBar.position.set(0, 0.26, 0.15);
        torso.add(datumBar);
      } else if (specialistIndex === 2) {
        for (const side of [-1, 1]) {
          const toolPod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.065, 0.22, 8),
            shellMat
          );
          toolPod.position.set(side * 0.22, 0.28, -0.13);
          toolPod.rotation.z = side * 0.08;
          torso.add(toolPod);
        }
        const makerRail = new THREE.Mesh(
          new THREE.BoxGeometry(0.15, 0.025, 0.02),
          visorMat
        );
        makerRail.position.set(0, -0.14, 0.055);
        elbowJoints[1].add(makerRail);
      } else if (specialistIndex === 3) {
        const bridgeRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.17, 0.012, 7, 32),
          visorMat
        );
        bridgeRing.position.set(0, 0.36, 0.12);
        torso.add(bridgeRing);
        const shoulderBridge = new THREE.Mesh(
          new THREE.BoxGeometry(0.64, 0.035, 0.07),
          jointMat
        );
        shoulderBridge.position.set(0, 0.56, -0.025);
        torso.add(shoulderBridge);
      } else if (specialistIndex === 4) {
        const auditLens = new THREE.Mesh(
          new THREE.TorusGeometry(0.075, 0.012, 7, 30),
          visorMat
        );
        auditLens.position.set(-0.055, 0.03, 0.17);
        head.add(auditLens);
        const evidenceArray = new THREE.Mesh(
          new THREE.BoxGeometry(0.035, 0.24, 0.08),
          shellMat
        );
        evidenceArray.position.set(-0.2, 0.36, -0.1);
        torso.add(evidenceArray);
      } else {
        const finishCollar = new THREE.Mesh(
          new THREE.TorusGeometry(0.22, 0.014, 7, 34, Math.PI * 1.5),
          visorMat
        );
        finishCollar.rotation.set(Math.PI / 2, 0, Math.PI * 0.75);
        finishCollar.position.set(0, 0.57, 0);
        torso.add(finishCollar);
        for (const side of [-1, 1]) {
          const trimFin = new THREE.Mesh(
            new THREE.ConeGeometry(0.035, 0.2, 4),
            shellMat
          );
          trimFin.position.set(side * 0.2, 0.49, -0.08);
          trimFin.rotation.z = side * -0.25;
          torso.add(trimFin);
        }
      }

      const padMat = new THREE.MeshBasicMaterial({
        color: supportColor,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(0.38, 0.55, 36),
        padMat
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.y = 0.012;
      root.add(pad);

      const joints: SupportJoints = {
        torso,
        head,
        shoulderL: shoulderJoints[0],
        shoulderR: shoulderJoints[1],
        elbowL: elbowJoints[0],
        elbowR: elbowJoints[1],
        hipL: hipJoints[0],
        hipR: hipJoints[1],
        kneeL: kneeJoints[0],
        kneeR: kneeJoints[1],
      };
      return {
        root,
        joints,
        shellMat,
        glowMat,
        visorMat,
        pad,
        padMat,
      };
    };

    // --- Rigs ---
    const sceneAgents = propsRef.current.agents;
    const patrolWaypoints = [
      [
        new THREE.Vector3(-7.55, FLOOR_Y, -2.75),
        new THREE.Vector3(-13.2, FLOOR_Y, -1.8),
        new THREE.Vector3(-18.35, FLOOR_Y, -3.25),
        new THREE.Vector3(-13.2, FLOOR_Y, -1.8),
        new THREE.Vector3(-4.15, FLOOR_Y, 2.25),
        new THREE.Vector3(agentX[0], FLOOR_Y, 0),
      ],
      [
        new THREE.Vector3(-2.15, FLOOR_Y, -2.65),
        new THREE.Vector3(-13.2, FLOOR_Y, 0),
        new THREE.Vector3(-18.35, FLOOR_Y, 0),
        new THREE.Vector3(-13.2, FLOOR_Y, 0),
        new THREE.Vector3(2.15, FLOOR_Y, -2.2),
        new THREE.Vector3(agentX[1], FLOOR_Y, 0),
      ],
      [
        new THREE.Vector3(4.15, FLOOR_Y, 2.25),
        new THREE.Vector3(-13.2, FLOOR_Y, 1.8),
        new THREE.Vector3(-18.35, FLOOR_Y, 3.25),
        new THREE.Vector3(-13.2, FLOOR_Y, 1.8),
        new THREE.Vector3(7.55, FLOOR_Y, -2.75),
        new THREE.Vector3(agentX[2], FLOOR_Y, 0),
      ],
    ];
    const rigs: AgentRig[] = sceneAgents.map((a, i) => {
      const x = agentX[i] ?? (i - 1) * 4.6;
      const home = new THREE.Vector3(x, FLOOR_Y, 0);
      const { root, joints, mats } = buildBot(a.color, i, i);
      root.position.copy(home);
      scene.add(root);
      const color = new THREE.Color(a.color);

      // orbiting energy motes around the torso
      const moteCount = 26;
      const moteGeo = new THREE.BufferGeometry();
      const motePos = new Float32Array(moteCount * 3);
      for (let m = 0; m < moteCount; m++) {
        const rr = 0.9 + Math.random() * 0.7;
        const th = Math.random() * Math.PI * 2;
        const ph = (Math.random() - 0.5) * 1.4;
        motePos[m * 3] = rr * Math.cos(th);
        motePos[m * 3 + 1] = rr * Math.sin(ph) * 0.9;
        motePos[m * 3 + 2] = rr * Math.sin(th);
      }
      moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
      const motesMat = new THREE.PointsMaterial({
        color,
        size: 0.055,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const motes = new THREE.Points(moteGeo, motesMat);
      motes.position.y = 1.55;
      root.add(motes);

      // progress ring wrapping the figure at chest height (billboarded)
      const billboard = new THREE.Group();
      billboard.position.y = 1.6;
      const trackMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      billboard.add(new THREE.Mesh(new THREE.RingGeometry(1.32, 1.38, 72), trackMat));
      const progressMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const progressMesh = new THREE.Mesh(
        new THREE.RingGeometry(1.3, 1.4, 72, 1, Math.PI / 2, 0.001),
        progressMat
      );
      billboard.add(progressMesh);
      root.add(billboard);

      // energy pillar + landing pad
      const pillarMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.03,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.78, 3.3, 24, 1, true),
        pillarMat
      );
      pillar.position.set(x, FLOOR_Y + 1.55, 0);
      scene.add(pillar);

      const padMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.5, 48), padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(x, FLOOR_Y + 0.01, 0);
      scene.add(pad);

      return {
        root,
        joints,
        mats,
        motes,
        motesMat,
        billboard,
        progressMesh,
        progressMat,
        trackMat,
        pillar,
        pillarMat,
        pad,
        padMat,
        lastProgress: -1,
        energy: 0.3,
        headYaw: 0,
        prevStatus: "idle" as AgentSceneStatus,
        waveUntil: 0,
        chestAnchor: new THREE.Vector3(x, FLOOR_Y + 1.66, 0.15),
        home,
        waypoints: patrolWaypoints[i] ?? [home.clone()],
        waypointIndex: 0,
        pauseUntil: performance.now() + 5000 + i * 1400,
        walkBlend: 0,
        moveSpeed: 0,
        gaitPhase: i * Math.PI * 0.38,
        facingYaw: 0,
        celebrateUntil: 0,
      };
    });

    const supportRigs: SupportRig[] = [];
    sceneAgents.forEach((agent, parentIndex) => {
      agent.supports.slice(0, 2).forEach((support, supportIndex) => {
        const flatIndex = parentIndex * 2 + supportIndex;
        const home = supportHomes[flatIndex].clone();
        const built = buildSupportBot(agent.color, parentIndex, supportIndex);
        built.root.position.copy(home);
        scene.add(built.root);
        supportRigs.push({
          root: built.root,
          joints: built.joints,
          parentIndex,
          supportIndex,
          label: support.label,
          role: support.role,
          home,
          anchor: new THREE.Vector3(home.x, FLOOR_Y + 1.04, home.z),
          phase: parentIndex * 2.2 + supportIndex * 1.1,
          energy: 0.2,
          shellMat: built.shellMat,
          glowMat: built.glowMat,
          visorMat: built.visorMat,
          pad: built.pad,
          padMat: built.padMat,
        });
      });
    });

    // Lead-to-specialist delegation relays. A traveling bead shows work being
    // handed down while the parent team is active.
    const supportRelays: SupportRelay[] = supportRigs.map((support, flatIndex) => {
      const parent = rigs[support.parentIndex];
      const from = parent.chestAnchor.clone();
      const to = support.anchor.clone();
      const mid = from.clone().add(to).multiplyScalar(0.5);
      mid.y += 0.65;
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
      const points = curve.getPoints(20);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const color = new THREE.Color(
        sceneAgents[support.parentIndex]?.color ?? "#7fa7ff"
      );
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.06,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      const beadMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const bead = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.045, 0),
        beadMat
      );
      scene.add(bead);
      return {
        curve,
        line,
        geo,
        mat,
        bead,
        beadMat,
        parentIndex: support.parentIndex,
        supportIndex: flatIndex,
      };
    });

    // --- Completion shockwaves (expand along the floor) ---
    const shockwaves: Shockwave[] = [];
    const spawnShockwave = (x: number, z: number, colorHex: string) => {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.035, 8, 64), mat);
      mesh.position.set(x, FLOOR_Y + 0.05, z);
      mesh.rotation.x = -Math.PI / 2;
      scene.add(mesh);
      shockwaves.push({ mesh, mat, born: performance.now() });
    };

    // --- Particle data-streams (chest to chest) ---
    const makeLink = (
      from: THREE.Vector3,
      to: THREE.Vector3,
      cFrom: string,
      cTo: string,
      activator: number,
      arcHeight: number,
      fromAgent: number | null,
      toAgent: number
    ): LinkRig => {
      const mid = from.clone().add(to).multiplyScalar(0.5);
      mid.y += arcHeight;
      mid.z += 0.9;
      const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
      const count = 130;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      const offsets = new Float32Array(count);
      const jitter = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        offsets[i] = Math.random();
        jitter[i] = Math.random() * Math.PI * 2;
      }
      const mat = new THREE.PointsMaterial({
        size: 0.09,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      return {
        points,
        mat,
        geo,
        curve,
        offsets,
        jitter,
        colorFrom: new THREE.Color(cFrom),
        colorTo: new THREE.Color(cTo),
        activity: 0,
        count,
        activator,
        arcHeight,
        fromAgent,
        toAgent,
      };
    };

    const links: LinkRig[] = [];
    const inputOrigin = new THREE.Vector3(0, -1.7, 7.3);
    if (sceneAgents.length >= 3) {
      links.push(
        makeLink(
          inputOrigin,
          rigs[0].chestAnchor,
          "#ffffff",
          sceneAgents[0].color,
          0,
          0.5,
          null,
          0
        ),
        makeLink(
          rigs[0].chestAnchor,
          rigs[1].chestAnchor,
          sceneAgents[0].color,
          sceneAgents[1].color,
          1,
          1.6,
          0,
          1
        ),
        makeLink(
          rigs[1].chestAnchor,
          rigs[2].chestAnchor,
          sceneAgents[1].color,
          sceneAgents[2].color,
          2,
          1.6,
          1,
          2
        )
      );
    }

    // --- Interaction ---
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2(-10, -10);
    let hoverIndex = -1;
    let hoverLibrary = false;
    let pointerDirty = true;
    const gesture = new SceneGesture();
    const hitRoots: THREE.Object3D[] = [...rigs.map((rig) => rig.root), libraryHitBox, librarySign];
    const updatePointer = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      pointerNDC.x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      pointerNDC.y = -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
      pointerDirty = true;
    };
    const pickAgent = () => {
      hitRoots.forEach((root) => root.updateWorldMatrix(true, true));
      camera.updateMatrixWorld();
      raycaster.setFromCamera(pointerNDC, camera);
      hoverIndex = -1;
      hoverLibrary = false;
      for (const hit of raycaster.intersectObjects(hitRoots, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object) {
          if (object.userData.library && propsRef.current.onLibraryClick) { hoverLibrary = true; break; }
          if (object.userData.agentIndex !== undefined) {
            hoverIndex = object.userData.agentIndex as number;
            break;
          }
          object = object.parent;
        }
        if (hoverIndex >= 0 || hoverLibrary) break;
      }
      pointerDirty = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      gesture.start(e.pointerId, e.clientX, e.clientY);
      dragging = gesture.active;
      updatePointer(e);
      mount.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      updatePointer(e);
      const delta = gesture.move(e.pointerId, e.clientX, e.clientY);
      azimuthT -= delta.x * 0.005;
      polarT = Math.min(1.5, Math.max(0.35, polarT - delta.y * 0.004));
      radiusT = zoomRadius(radiusT, delta.zoom);
    };
    const onPointerUp = (e: PointerEvent) => {
      const isTap = gesture.end(e.pointerId, e.clientX, e.clientY);
      dragging = gesture.active;
      if (mount.hasPointerCapture?.(e.pointerId)) mount.releasePointerCapture(e.pointerId);
      if (!isTap) return;
      // Touch has no hover phase. Pick at release so the first tap is accurate.
      updatePointer(e);
      pickAgent();
      if (hoverLibrary) {
        propsRef.current.onLibraryClick?.();
      } else if (hoverIndex >= 0) {
        const rig = rigs[hoverIndex];
        rig.waveUntil = performance.now() + 1500; // wave hello
        // focus camera on this bot
        camTargetT.set(
          rig.root.position.x * 0.8,
          -0.4,
          rig.root.position.z * 0.5
        );
        radiusT = Math.min(radiusT, 10.5);
        const agent = propsRef.current.agents[hoverIndex];
        if (agent) propsRef.current.onAgentClick?.(agent.id);
      } else {
        // Recenter the room currently selected in the HUD.
        applyCameraFocus(propsRef.current.focusZone ?? "studio");
      }
    };
    const onPointerCancel = (e: PointerEvent) => {
      gesture.cancel(e.pointerId);
      dragging = gesture.active;
    };
    const onPointerLeave = () => {
      if (dragging) return;
      pointerNDC.set(-10, -10);
      hoverIndex = -1;
      hoverLibrary = false;
      pointerDirty = true;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? mount.clientHeight : 1;
      radiusT = zoomRadius(radiusT, Math.exp(Math.max(-1, Math.min(1, e.deltaY * units * 0.001))));
    };

    mount.addEventListener("pointerdown", onPointerDown);
    mount.addEventListener("pointermove", onPointerMove);
    mount.addEventListener("pointerup", onPointerUp);
    mount.addEventListener("pointercancel", onPointerCancel);
    mount.addEventListener("lostpointercapture", onPointerCancel);
    mount.addEventListener("pointerleave", onPointerLeave);
    mount.addEventListener("wheel", onWheel, { passive: false });

    // --- Resize ---
    let sceneInView = true;
    let hasSceneSize = mount.clientWidth > 0 && mount.clientHeight > 0;
    let raf = 0;
    let lastFrameAt = 0;
    let resetDelta = true;
    const scheduleFrame = () => {
      if (!raf && !sceneDisposed && !document.hidden && sceneInView && hasSceneSize) {
        raf = requestAnimationFrame(animate);
      }
    };
    const suspendFrames = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      resetDelta = true;
    };
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      hasSceneSize = w > 0 && h > 0;
      if (!hasSceneSize) {
        suspendFrames();
        return;
      }
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloomPass.resolution.set(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pointerDirty = true;
      scheduleFrame();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // --- Pose targets per status ---
    // sa = shoulder (x fwd/back, z out), fa = forearm x, hx = head pitch, lean = torso pitch
    const POSES: Record<AgentSceneStatus, { saX: number; saZ: number; faX: number; hX: number; lean: number }> = {
      idle: { saX: -0.05, saZ: 0.16, faX: -0.28, hX: 0.02, lean: 0.02 },
      waiting: { saX: 0, saZ: 0.07, faX: -0.12, hX: 0.42, lean: 0.06 },
      running: { saX: -1.15, saZ: 0.12, faX: -0.6, hX: 0.2, lean: 0.1 },
      done: { saX: -0.15, saZ: 0.2, faX: -0.3, hX: -0.1, lean: -0.02 },
    };
    // --- Animation loop ---
    const tmpV = new THREE.Vector3();
    const tmpC = new THREE.Color();
    let activeQuality: SceneQuality = quality;
    let animationTime = 0;
    const applyRenderQuality = (nextQuality: SceneQuality) => {
      activeQuality = nextQuality;
      renderer.setPixelRatio(nextQuality === "eco" ? 1 : autoPixelRatio);
      bloomPass.enabled = nextQuality !== "eco";
      bloomPass.strength =
        nextQuality === "eco" ? 0.24 : lowPower ? 0.34 : 0.46;
      resize();
    };

    const animate = () => {
      raf = 0;
      if (document.hidden || !sceneInView || !hasSceneSize || sceneDisposed) return;
      scheduleFrame();
      reducedMotion = propsRef.current.reduceMotion ?? systemReducedMotion;
      const motionPaused = reducedMotion || Boolean(propsRef.current.ambientPaused);
      mount.dataset.sceneMotion = reducedMotion ? "reduced" : motionPaused ? "paused" : "full";
      const requestedQuality = propsRef.current.quality ?? "auto";
      if (requestedQuality !== activeQuality) {
        applyRenderQuality(requestedQuality);
      }
      const frameNow = performance.now();
      const { agents: liveAgents } = propsRef.current;
      const hasLiveWork = liveAgents.some((agent) => agent.status === "running");
      const cameraMoving =
        dragging ||
        Math.abs(azimuthT - azimuth) > 0.002 ||
        Math.abs(polarT - polar) > 0.002 ||
        Math.abs(radiusT - radius) > 0.01 ||
        camTarget.distanceToSquared(camTargetT) > 0.0004;
      const targetFrameMs = reducedMotion || motionPaused
        ? cameraMoving ? 16 : 125
        : activeQuality === "eco"
          ? hasLiveWork || cameraMoving
            ? 42
            : 100
          : lowPower
            ? hasLiveWork || cameraMoving
              ? 42
              : 80
            : hasLiveWork || cameraMoving
              ? 16
              : 55;
      if (frameNow - lastFrameAt < targetFrameMs) return;
      const dt = resetDelta ? 1 / 30 : Math.min((frameNow - lastFrameAt) / 1000, 0.25);
      lastFrameAt = frameNow;
      resetDelta = false;
      if (!motionPaused) animationTime += dt;
      const t = animationTime;
      const blend = (amount: number) => reducedMotion ? 1 : frameBlend(amount, dt);
      const now = frameNow;

      // camera
      const requestedFocusZone = propsRef.current.focusZone ?? "studio";
      if (requestedFocusZone !== activeFocusZone) {
        applyCameraFocus(requestedFocusZone);
      }
      const cameraBlend = reducedMotion ? 1 : motionBlend(dragging ? 14 : 7.5, dt);
      azimuth += (azimuthT - azimuth) * cameraBlend;
      polar += (polarT - polar) * cameraBlend;
      radius += (radiusT - radius) * cameraBlend;
      camTarget.lerp(camTargetT, cameraBlend);
      camera.position.set(
        camTarget.x + radius * Math.sin(polar) * Math.sin(azimuth),
        camTarget.y + radius * Math.cos(polar),
        camTarget.z + radius * Math.sin(polar) * Math.cos(azimuth)
      );
      camera.lookAt(camTarget);

      // hover raycast against whole bots
      if (pointerDirty || cameraMoving) pickAgent();
      mount.style.cursor = dragging ? "grabbing" : hoverIndex >= 0 || hoverLibrary ? "pointer" : "grab";

      if (!motionPaused) {
        stars.rotation.y = t * 0.004;
        distantMoon.rotation.y = t * 0.018;
        planetRing.rotation.z = 0.48 + Math.sin(t * 0.04) * 0.035;
        serviceDrone.position.set(
          Math.sin(t * 0.16) * 9.8,
          1.5 + Math.sin(t * 0.72) * 0.16,
          -6.75 + Math.cos(t * 0.16) * 0.45
        );
        serviceDrone.rotation.y = -t * 0.7;
        droneRing.rotation.z = t * 0.9;
        projectionCore.rotation.y += dt * 0.32;
        projectionCore.rotation.x = Math.sin(t * 0.22) * 0.16;
        projectionRings.forEach((ring, ringIndex) => {
          ring.rotation.z += dt * (0.09 + ringIndex * 0.035);
        });
        trafficLights.forEach((traffic) => {
          const lane = traffic.userData.lane as number;
          const direction = lane % 2 === 0 ? 1 : -1;
          traffic.position.x +=
            (traffic.userData.speed as number) * direction * dt;
          if (traffic.position.x > 15) traffic.position.x = -15;
          if (traffic.position.x < -15) traffic.position.x = 15;
        });
        steamWisps.forEach((steam) => {
          const phase = steam.userData.phase as number;
          steam.position.y =
            (steam.userData.baseY as number) +
            ((t * 0.08 + phase * 0.17) % 0.22);
          steam.position.x += Math.sin(t * 0.62 + phase) * dt * 0.006;
          steam.rotation.z = Math.PI / 2 + Math.sin(t * 0.5 + phase) * 0.16;
        });
      }

      workstationScreens.forEach((screen, i) => {
        const status = liveAgents[i]?.status ?? "idle";
        const pulse = reducedMotion ? 0 : (Math.sin(t * 4.2 + i) + 1) * 0.025;
        screen.opacity =
          status === "running"
            ? 0.24 + pulse
            : status === "done"
              ? 0.16
              : status === "waiting"
                ? 0.08
                : 0.055;
      });
      supportScreenMats.forEach(({ mat, parentIndex, supportIndex }) => {
        const status = liveAgents[parentIndex]?.status ?? "idle";
        const pulse = reducedMotion
          ? 0
          : (Math.sin(t * 6.2 + parentIndex * 1.4 + supportIndex) + 1) * 0.035;
        mat.opacity =
          status === "running"
            ? 0.2 + pulse
            : status === "done"
              ? 0.12
              : status === "waiting"
                ? 0.055
                : 0.04;
      });
      teamBeaconMats.forEach((mat, parentIndex) => {
        const status = liveAgents[parentIndex]?.status ?? "idle";
        mat.opacity =
          status === "running"
            ? 0.32 + (reducedMotion ? 0 : Math.sin(t * 4.5 + parentIndex) * 0.06)
            : status === "done"
              ? 0.2
              : status === "waiting"
                ? 0.07
              : 0.1;
      });

      const localPracticeAvailable = liveAgents.every(
        (agent) => agent.status === "idle" || agent.status === "done"
      );
      gymPulseMats.forEach((mat, index) => {
        const pulse =
          reducedMotion || !localPracticeAvailable
            ? 0
            : (Math.sin(t * 2.2 + index * 0.65) + 1) * 0.025;
        mat.opacity = localPracticeAvailable ? 0.1 + pulse : 0.025;
      });
      if (!motionPaused && localPracticeAvailable) {
        gymRings.forEach((ring, index) => {
          ring.rotation.z += dt * (0.08 + (index % 4) * 0.025);
        });
        gymDummies.forEach((dummy, index) => {
          const phase = dummy.userData.phase as number;
          dummy.rotation.y = Math.sin(t * 0.42 + phase) * 0.1;
          dummy.position.y =
            FLOOR_Y + Math.abs(Math.sin(t * 1.1 + index)) * 0.012;
        });
      }

      ambientNotes.forEach((note, noteIndex) => {
        const agentIndex = Math.floor(noteIndex / 3);
        const status = liveAgents[agentIndex]?.status ?? "idle";
        const phase = note.userData.phase as number;
        ambientNoteMats[noteIndex].opacity =
          status === "running" ? 0.11 : status === "done" ? 0.075 : 0.04;
        if (!motionPaused) {
          note.position.y =
            (note.userData.baseY as number) + Math.sin(t * 0.58 + phase) * 0.055;
          note.rotation.z = Math.sin(t * 0.36 + phase) * 0.025;
        }
      });

      if (!motionPaused) {
        memoryArchive.rotation.y = Math.sin(t * 0.16) * 0.14;
        archiveRing.rotation.z += dt * 0.34;
        archiveCards.forEach((card) => {
          card.position.y =
            (card.userData.baseY as number) +
            Math.sin(t * 0.48 + (card.userData.phase as number)) * 0.035;
        });
      }

      // bots
      rigs.forEach((rig, i) => {
        const live = liveAgents[i];
        const status: AgentSceneStatus = live?.status ?? "idle";
        const progress = live?.progress ?? 0;
        const J = rig.joints;
        const phase = i * 2.1;

        // Idle agents patrol role-specific corners of the office. Active agents
        // return to their station quickly before resuming status-driven work.
        const returningToStation = status !== "idle";
        const destination = returningToStation
          ? rig.home
          : rig.waypoints[rig.waypointIndex];
        const canMove = !motionPaused && (returningToStation || now >= rig.pauseUntil);
        const dx = destination.x - rig.root.position.x;
        const dz = destination.z - rig.root.position.z;
        const distance = Math.hypot(dx, dz);
        const wantsToMove = canMove && distance > 0.065;
        const cruiseSpeed = returningToStation ? 1.92 : 0.62 + i * 0.035;
        const arrivalRange = returningToStation ? 1.55 : 0.92;
        const arrivalBlend = THREE.MathUtils.smoothstep(
          Math.min(distance, arrivalRange),
          0,
          arrivalRange
        );
        const targetSpeed = wantsToMove
          ? cruiseSpeed * (0.24 + arrivalBlend * 0.76)
          : 0;
        const speedResponse = targetSpeed > rig.moveSpeed ? 3.4 : 6.2;
        rig.moveSpeed +=
          (targetSpeed - rig.moveSpeed) * motionBlend(speedResponse, dt);
        const walking = wantsToMove && rig.moveSpeed > 0.035;
        let travel = 0;

        if (reducedMotion) {
          rig.root.position.x = rig.home.x;
          rig.root.position.z = rig.home.z;
          rig.facingYaw = 0;
          rig.moveSpeed = 0;
        } else if (walking) {
          travel = Math.min(distance, rig.moveSpeed * dt);
          rig.root.position.x += (dx / distance) * travel;
          rig.root.position.z += (dz / distance) * travel;
          const desiredYaw = Math.atan2(dx, dz);
          const yawDelta = Math.atan2(
            Math.sin(desiredYaw - rig.facingYaw),
            Math.cos(desiredYaw - rig.facingYaw)
          );
          rig.facingYaw += yawDelta * motionBlend(7.5, dt);
        } else if (distance <= 0.065) {
          rig.root.position.x = destination.x;
          rig.root.position.z = destination.z;
          if (returningToStation) {
            const yawDelta = Math.atan2(
              Math.sin(-rig.facingYaw),
              Math.cos(-rig.facingYaw)
            );
            rig.facingYaw += yawDelta * motionBlend(6, dt);
          } else if (canMove) {
            rig.waypointIndex = (rig.waypointIndex + 1) % rig.waypoints.length;
            rig.pauseUntil = now + 3800 + i * 650 + rig.waypointIndex * 520;
          }
        }
        if (!walking && !motionPaused) {
          const desiredRestYaw = returningToStation
            ? 0
            : Math.atan2(-rig.root.position.x, -rig.root.position.z || 0.001);
          const restYawDelta = Math.atan2(
            Math.sin(desiredRestYaw - rig.facingYaw),
            Math.cos(desiredRestYaw - rig.facingYaw)
          );
          rig.facingYaw += restYawDelta * motionBlend(2.8, dt);
        }
        rig.root.rotation.y = rig.facingYaw;
        rig.walkBlend +=
          ((walking ? 1 : 0) - rig.walkBlend) *
          (reducedMotion ? 1 : motionBlend(walking ? 6.8 : 9.5, dt));
        if (travel > 0) {
          // Distance-driven phase keeps feet in step with the floor and avoids sliding.
          rig.gaitPhase += travel * 7.7;
        }

        if (status === "done" && rig.prevStatus === "running") {
          if (!motionPaused) {
            spawnShockwave(
              rig.root.position.x,
              rig.root.position.z,
              live?.color ?? "#ffffff"
            );
          }
          rig.waveUntil = now + 900;
          rig.celebrateUntil = now + 1850;
        }
        rig.prevStatus = status;

        const adaptationEnergy =
          live?.trainingActive && status === "idle" ? 0.18 : 0;
        const target =
          ENERGY_TARGET[status] + adaptationEnergy + (hoverIndex === i ? 0.18 : 0);
        rig.energy += (target - rig.energy) * blend(0.06);
        const e = rig.energy;
        const amp = reducedMotion ? 0 : 1;
        const pose = POSES[status];
        const gait = Math.sin(rig.gaitPhase);
        const speedStride = THREE.MathUtils.clamp(
          rig.moveSpeed / Math.max(0.62, cruiseSpeed),
          0.42,
          1.08
        );
        const stride = gait * 0.54 * speedStride * rig.walkBlend * amp;
        const gaitBob = Math.abs(Math.sin(rig.gaitPhase)) * 0.04;
        const awayFromHome =
          Math.hypot(
            rig.root.position.x - rig.home.x,
            rig.root.position.z - rig.home.z
          ) > 0.25;
        const ambientRoleAction =
          status === "idle" && !walking && rig.walkBlend < 0.12 && awayFromHome;

        // materials breathe with energy
        rig.mats.solid.opacity = 0.26 + e * 0.34;
        rig.mats.wire.opacity = 0.16 + e * 0.32;
        rig.mats.core.opacity = 0.55 + e * 0.42;
        rig.mats.halo.opacity = 0.1 + e * 0.5;
        rig.mats.shell.opacity = 0.46 + e * 0.34;
        rig.mats.shell.emissiveIntensity = 0.22 + e * 0.55;
        rig.mats.joint.opacity = 0.64 + e * 0.24;
        rig.mats.joint.emissiveIntensity = 0.12 + e * 0.34;
        rig.mats.visor.opacity = 0.52 + e * 0.46;
        rig.mats.chestGlow.opacity = 0.14 + e * 0.5;
        rig.mats.headGlow.opacity = 0.1 + e * 0.4;
        if (!motionPaused) J.halo.rotation.z += (0.3 + e * 1.8) * dt;

        // Walk cycle, weight shift, and breathing.
        rig.root.position.y =
          FLOOR_Y +
          gaitBob * rig.walkBlend * amp +
          Math.abs(Math.sin(t * 1.1 + phase)) * 0.018 * (1 - rig.walkBlend) * amp;
        J.torso.scale.y = 1 + Math.sin(t * 1.6 + phase) * 0.015 * amp;
        J.hips.position.x =
          (Math.sin(t * 0.9 + phase) * 0.02 * (1 - rig.walkBlend) +
            gait * 0.028 * rig.walkBlend) *
          amp;
        J.hips.rotation.y =
          Math.sin(t * 0.6 + phase) * 0.04 * (1 - rig.walkBlend) * amp;
        J.hips.rotation.z +=
          (gait * 0.045 * rig.walkBlend * amp - J.hips.rotation.z) * blend(0.16);
        J.hipL.rotation.x += (stride - J.hipL.rotation.x) * blend(0.18);
        J.hipR.rotation.x += (-stride - J.hipR.rotation.x) * blend(0.18);
        J.kneeL.rotation.x +=
          (Math.max(0, -gait) * 0.58 * rig.walkBlend - J.kneeL.rotation.x) * blend(0.2);
        J.kneeR.rotation.x +=
          (Math.max(0, gait) * 0.58 * rig.walkBlend - J.kneeR.rotation.x) * blend(0.2);
        J.ankleL.rotation.x +=
          ((-stride * 0.28 + Math.max(0, gait) * 0.16) * rig.walkBlend -
            J.ankleL.rotation.x) *
          blend(0.22);
        J.ankleR.rotation.x +=
          ((stride * 0.28 + Math.max(0, -gait) * 0.16) * rig.walkBlend -
            J.ankleR.rotation.x) *
          blend(0.22);

        // torso lean
        const torsoLean = pose.lean * (1 - rig.walkBlend) + 0.1 * rig.walkBlend;
        J.torso.rotation.x += (torsoLean - J.torso.rotation.x) * blend(0.08);
        J.torso.rotation.y +=
          (-gait * 0.075 * rig.walkBlend * amp - J.torso.rotation.y) * blend(0.12);

        // head: pose pitch + hover tracking (turns to face the camera)
        const relAz = Math.atan2(
          camera.position.x - rig.root.position.x,
          camera.position.z - rig.root.position.z
        );
        const relativeHeadYaw = Math.atan2(
          Math.sin(relAz - rig.root.rotation.y),
          Math.cos(relAz - rig.root.rotation.y)
        );
        const yawTarget =
          hoverIndex === i
            ? THREE.MathUtils.clamp(relativeHeadYaw, -0.85, 0.85)
            : ambientRoleAction
              ? Math.sin(t * 0.6 + phase) * 0.25
              : 0;
        rig.headYaw += (yawTarget - rig.headYaw) * blend(0.1);
        J.head.rotation.y =
          rig.headYaw + Math.sin(t * 0.8 + phase) * 0.045 * (1 - rig.walkBlend) * amp;
        const headBob =
          status === "running" && rig.walkBlend < 0.1
            ? Math.sin(t * 5 + phase) * 0.06 * amp
            : 0;
        J.head.rotation.x += (pose.hX + headBob - J.head.rotation.x) * blend(0.09);

        // Arm targets blend status work, walking counter-swing, and quiet role actions.
        const typing =
          status === "running" && rig.walkBlend < 0.1
            ? Math.sin(t * 9 + phase) * 0.18 * amp
            : 0;
        const sway =
          status === "idle"
            ? Math.sin(t * 1.2 + phase) * 0.05 * (1 - rig.walkBlend) * amp
            : 0;
        let saLX = pose.saX + typing * 0.4;
        let saLZ = pose.saZ + sway;
        let faLX = pose.faX + typing;
        let saRX = pose.saX;
        let saRZ = -pose.saZ;
        let faRX = pose.faX;

        if (rig.walkBlend > 0.02) {
          saLX = -stride * 0.72;
          saRX = stride * 0.72;
          saLZ = 0.1;
          saRZ = -0.1;
          faLX = -0.16;
          faRX = -0.16;
        } else if (ambientRoleAction) {
          const gesture = (Math.sin(t * 0.72 + phase) + 1) * 0.5;
          if (i === 0) {
            // Strategist gestures toward the planning wall.
            saLX = -1.35 - gesture * 0.22;
            saLZ = 0.45;
            faLX = -0.3;
          } else if (i === 1) {
            // Builder checks a wrist interface.
            saRX = -1.72;
            saRZ = -0.28;
            faRX = -0.9 + gesture * 0.16;
          } else {
            // Editor holds a compact reading pose.
            saLX = -1.16;
            saRX = -1.16;
            saLZ = 0.2;
            saRZ = -0.2;
            faLX = -0.72;
            faRX = -0.72;
          }
        }

        // Right arm also owns click feedback and completion salutes.
        const waving = !motionPaused && now < rig.waveUntil;
        const acknowledging = !motionPaused && status === "done" && now < rig.celebrateUntil;
        if (acknowledging && !waving && rig.walkBlend < 0.1) {
          saRX = -1.62;
          saRZ = -0.2;
          faRX = -0.62;
        }
        if (waving) {
          saRX = -2.35;
          saRZ = -0.45;
          faRX = -0.5 + Math.sin(t * 13) * 0.5 * amp; // wave the forearm
        }
        const typingR =
          status === "running" && !waving && rig.walkBlend < 0.1
            ? Math.cos(t * 9 + phase) * 0.18 * amp
            : 0;
        J.shoulderL.rotation.x += (saLX - J.shoulderL.rotation.x) * blend(0.09);
        J.shoulderL.rotation.z += (saLZ - J.shoulderL.rotation.z) * blend(0.09);
        J.elbowL.rotation.x += (faLX - J.elbowL.rotation.x) * blend(0.12);
        J.shoulderR.rotation.x += (saRX + typingR * 0.4 - J.shoulderR.rotation.x) * blend(waving ? 0.16 : 0.09);
        J.shoulderR.rotation.z += (saRZ - J.shoulderR.rotation.z) * blend(waving ? 0.16 : 0.09);
        J.elbowR.rotation.x += (faRX + typingR - J.elbowR.rotation.x) * blend(waving ? 0.3 : 0.12);
        const wristWork =
          status === "running" && rig.walkBlend < 0.1
            ? Math.sin(t * 10.5 + phase) * 0.14 * amp
            : 0;
        J.wristL.rotation.x +=
          (wristWork - J.wristL.rotation.x) * blend(status === "running" ? 0.18 : 0.1);
        J.wristR.rotation.x +=
          (-wristWork - J.wristR.rotation.x) * blend(status === "running" ? 0.18 : 0.1);
        J.wristL.rotation.z +=
          ((ambientRoleAction ? -0.12 : 0.03 * rig.walkBlend) -
            J.wristL.rotation.z) *
          blend(0.09);
        J.wristR.rotation.z +=
          ((waving ? Math.sin(t * 13) * 0.22 : ambientRoleAction ? 0.12 : -0.03 * rig.walkBlend) -
            J.wristR.rotation.z) *
          blend(0.12);

        // motes / pillar / pad
        if (!motionPaused) rig.motes.rotation.y += (0.06 + e * 0.66) * dt;
        rig.motesMat.opacity = 0.08 + e * 0.5;
        const runPulse =
          status === "running"
            ? Math.sin(t * 7 + phase) * 0.1 * amp
            : live?.trainingActive
              ? Math.sin(t * 2.4 + phase) * 0.035 * amp
              : 0;
        const breathe = reducedMotion ? 0 : Math.sin(t * 2.2 + phase) * 0.05;
        rig.pillarMat.opacity = 0.015 + e * 0.1 + runPulse * 0.15;
        rig.pillar.scale.set(1 + breathe * e, 1, 1 + breathe * e);
        rig.padMat.opacity = 0.04 + e * 0.3;
        if (!motionPaused) rig.pad.rotation.z += (0.03 + e * 0.24) * dt;

        // Keep handoff streams attached while agents are returning to their desks.
        tmpV.set(0, 1.66, 0.15);
        rig.root.localToWorld(tmpV);
        rig.chestAnchor.copy(tmpV);

        // progress ring
        rig.billboard.quaternion.copy(camera.quaternion);
        const showProgress =
          status === "running" || status === "done" || Boolean(live?.trainingActive);
        rig.trackMat.opacity = showProgress ? 0.14 : 0.04;
        rig.progressMat.opacity = showProgress ? 0.9 : 0;
        const p =
          status === "done"
            ? 1
            : live?.trainingActive
              ? live.trainingProgress ?? 0
              : progress;
        if (showProgress && Math.abs(p - rig.lastProgress) > 0.004) {
          rig.lastProgress = p;
          rig.progressMesh.geometry.dispose();
          rig.progressMesh.geometry = new THREE.RingGeometry(
            1.3,
            1.4,
            72,
            1,
            Math.PI / 2,
            Math.max(0.001, p) * Math.PI * 2
          );
        }
      });

      // Downline teams mirror their lead status with staggered specialist work.
      // Their smaller gestures keep the room active without diluting lead focus.
      supportRigs.forEach((support, flatIndex) => {
        const parent = liveAgents[support.parentIndex];
        const status: AgentSceneStatus = parent?.status ?? "idle";
        const parentProgress = parent?.progress ?? 0;
        const trainingActive = Boolean(parent?.trainingActive) && status === "idle";
        const phase = support.phase;
        const amp = reducedMotion ? 0 : 1;
        const engagement =
          status === "running"
            ? THREE.MathUtils.smoothstep(
                parentProgress + (support.supportIndex === 0 ? 0.12 : -0.08),
                0,
                0.48
              )
            : status === "done"
              ? 0.42
              : 0;
        const targetEnergy =
          status === "running"
            ? 0.34 + engagement * 0.52
            : status === "done"
              ? 0.55
              : status === "waiting"
              ? 0.1
                : trainingActive
                  ? 0.42
                  : 0.22;
        support.energy += (targetEnergy - support.energy) * blend(0.07);
        const e = support.energy;
        const workPulse = Math.sin(t * 9.4 + phase) * amp;
        const quietSway = Math.sin(t * 0.82 + phase) * amp;
        const delegationStagger =
          reducedMotion ? 0 : support.supportIndex === 0
            ? Math.sin(t * 1.15 + phase) * 0.035
            : Math.cos(t * 1.02 + phase) * 0.035;

        support.root.position.x =
          support.home.x +
          (status === "idle"
            ? quietSway * 0.035
            : status === "running"
              ? (support.supportIndex === 0 ? -0.035 : 0.035) * engagement
              : 0);
        support.root.position.z =
          support.home.z +
          (status === "idle"
            ? Math.cos(t * 0.64 + phase) * 0.025 * amp
            : status === "running"
              ? -0.08 * engagement
              : 0);
        support.root.position.y =
          support.home.y +
          (status === "running"
            ? Math.abs(Math.sin(t * 2.8 + phase)) * 0.018 * amp
            : Math.sin(t * (trainingActive ? 1.75 : 1.25) + phase) *
              (trainingActive ? 0.014 : 0.009) *
              amp);
        support.root.rotation.y =
          status === "idle"
            ? quietSway * 0.08
            : status === "running"
              ? (support.supportIndex === 0 ? 0.055 : -0.055) * engagement
              : 0;

        support.shellMat.opacity = 0.4 + e * 0.34;
        support.shellMat.emissiveIntensity = 0.16 + e * 0.6;
        support.glowMat.opacity = 0.2 + e * 0.58;
        support.visorMat.opacity = 0.38 + e * 0.56;
        support.padMat.opacity = 0.035 + e * 0.22;
        if (!motionPaused) {
          support.pad.rotation.z += (0.06 + e * 0.3) * dt;
        }

        const isWorking = status === "running" && engagement > 0.035;
        const isTraining = trainingActive && !reducedMotion;
        const roleWorkBase = support.supportIndex === 0 ? -0.94 : -1.18;
        const armBase = isWorking
          ? -0.16 + (roleWorkBase + 0.16) * engagement
          : isTraining
            ? -0.52
          : status === "waiting"
            ? -0.08
            : -0.16;
        const armTyping = isWorking
          ? workPulse * (support.supportIndex === 0 ? 0.08 : 0.14) * engagement
          : isTraining
            ? Math.sin(t * 3.2 + phase) * 0.055
          : quietSway * 0.035;
        support.joints.shoulderL.rotation.x +=
          (armBase + armTyping - support.joints.shoulderL.rotation.x) * blend(0.12);
        support.joints.shoulderR.rotation.x +=
          (armBase - armTyping - support.joints.shoulderR.rotation.x) * blend(0.12);
        support.joints.shoulderL.rotation.z +=
          (0.1 + delegationStagger - support.joints.shoulderL.rotation.z) * blend(0.1);
        support.joints.shoulderR.rotation.z +=
          (-0.1 - delegationStagger - support.joints.shoulderR.rotation.z) * blend(0.1);
        support.joints.elbowL.rotation.x +=
          (((isWorking || isTraining)
            ? -0.34 - engagement * 0.24 + workPulse * 0.12 * engagement
            : -0.18) -
            support.joints.elbowL.rotation.x) *
          blend(0.15);
        support.joints.elbowR.rotation.x +=
          (((isWorking || isTraining)
            ? -0.34 - engagement * 0.24 - workPulse * 0.16 * engagement
            : -0.18) -
            support.joints.elbowR.rotation.x) *
          blend(0.15);

        const legShift =
          status === "idle" ? quietSway * 0.08 : isWorking ? delegationStagger : 0;
        support.joints.hipL.rotation.x +=
          (legShift - support.joints.hipL.rotation.x) * blend(0.1);
        support.joints.hipR.rotation.x +=
          (-legShift - support.joints.hipR.rotation.x) * blend(0.1);
        support.joints.kneeL.rotation.x +=
          (Math.max(0, -legShift) * 0.4 -
            support.joints.kneeL.rotation.x) *
          blend(0.12);
        support.joints.kneeR.rotation.x +=
          (Math.max(0, legShift) * 0.4 -
            support.joints.kneeR.rotation.x) *
          blend(0.12);
        support.joints.torso.rotation.x +=
          ((isWorking
            ? 0.025 + engagement * 0.065
            : isTraining
              ? 0.04
              : 0.015) -
            support.joints.torso.rotation.x) *
          blend(0.08);
        support.joints.torso.rotation.y =
          delegationStagger * 0.7 * Math.max(0.3, engagement);
        support.joints.head.rotation.y =
          isWorking
            ? (support.supportIndex === 0
                ? Math.sin(t * 1.45 + phase) * 0.1
                : Math.sin(t * 2.2 + phase) * 0.045) *
              engagement *
              amp
            : quietSway * 0.16;
        const completionNod =
          status === "done" ? Math.sin(t * 2.4 + phase) * 0.06 * amp : 0;
        support.joints.head.rotation.x +=
          ((status === "waiting" ? 0.2 : completionNod) -
            support.joints.head.rotation.x) *
          blend(0.1);

        tmpV.set(0, 1.04, 0.1);
        support.root.localToWorld(tmpV);
        support.anchor.copy(tmpV);

        const label = supportLabelRefs.current[flatIndex];
        if (label) {
          tmpV.set(0, 1.62, 0);
          support.root.localToWorld(tmpV);
          tmpV.project(camera);
          if (tmpV.z > 1) {
            label.style.opacity = "0";
          } else {
            label.style.opacity =
              status === "running" || status === "done" ? "0.82" : "0.48";
            label.style.transform = `translate(-50%, -100%) translate(${((tmpV.x + 1) / 2) * mount.clientWidth}px, ${((-tmpV.y + 1) / 2) * mount.clientHeight}px)`;
          }
        }
      });

      supportRelays.forEach((relay, relayIndex) => {
        const support = supportRigs[relay.supportIndex];
        const parent = liveAgents[relay.parentIndex];
        const status: AgentSceneStatus = parent?.status ?? "idle";
        const from = rigs[relay.parentIndex].chestAnchor;
        const to = support.anchor;
        relay.curve.v0.copy(from);
        relay.curve.v2.copy(to);
        relay.curve.v1.copy(from).add(to).multiplyScalar(0.5);
        relay.curve.v1.y += 0.64;
        relay.curve.v1.z -= 0.14;
        const positions = relay.geo.getAttribute(
          "position"
        ) as THREE.BufferAttribute;
        for (let pointIndex = 0; pointIndex <= 20; pointIndex++) {
          relay.curve.getPoint(pointIndex / 20, tmpV);
          positions.setXYZ(pointIndex, tmpV.x, tmpV.y, tmpV.z);
        }
        positions.needsUpdate = true;
        const active = status === "running";
        relay.mat.opacity = active
          ? 0.32 + (reducedMotion ? 0 : Math.sin(t * 5 + relayIndex) * 0.05)
          : status === "done"
            ? 0.12
            : status === "waiting"
              ? 0.035
              : 0.055;
        relay.beadMat.opacity = active ? 0.9 : 0;
        if (active) {
          const beadT = reducedMotion
            ? support.supportIndex === 0
              ? 0.35
              : 0.7
            : (t * 0.42 + relayIndex * 0.31) % 1;
          relay.curve.getPoint(beadT, relay.bead.position);
          if (!motionPaused) relay.bead.rotation.y += dt * 2.2;
        }
      });

      // data streams
      links.forEach((link) => {
        const activator = liveAgents[link.activator];
        const active = activator?.status === "running";
        link.activity += ((active ? 1 : 0) - link.activity) * blend(0.05);
        link.mat.opacity = link.activity * 0.95;
        if (link.activity > 0.015) {
          const from =
            link.fromAgent === null ? inputOrigin : rigs[link.fromAgent].chestAnchor;
          const to = rigs[link.toAgent].chestAnchor;
          link.curve.v0.copy(from);
          link.curve.v2.copy(to);
          link.curve.v1.copy(from).add(to).multiplyScalar(0.5);
          link.curve.v1.y += link.arcHeight;
          link.curve.v1.z += 0.9;

          const posAttr = link.geo.getAttribute("position") as THREE.BufferAttribute;
          const colAttr = link.geo.getAttribute("color") as THREE.BufferAttribute;
          for (let i = 0; i < link.count; i++) {
            const tt = reducedMotion
              ? link.offsets[i]
              : (link.offsets[i] + t * 0.14) % 1;
            link.curve.getPoint(tt, tmpV);
            if (!reducedMotion) {
              const j = link.jitter[i];
              tmpV.x += Math.sin(t * 3 + j) * 0.05;
              tmpV.y += Math.cos(t * 2.6 + j * 1.3) * 0.05;
              tmpV.z += Math.sin(t * 2.2 + j * 0.7) * 0.05;
            }
            posAttr.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
            tmpC.lerpColors(link.colorFrom, link.colorTo, tt);
            colAttr.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
          }
          posAttr.needsUpdate = true;
          colAttr.needsUpdate = true;
        }
      });

      // shockwaves
      for (let i = shockwaves.length - 1; i >= 0; i--) {
        const sw = shockwaves[i];
        const age = motionPaused ? 1 : (now - sw.born) / 1100;
        if (age >= 1) {
          scene.remove(sw.mesh);
          sw.mesh.geometry.dispose();
          sw.mat.dispose();
          shockwaves.splice(i, 1);
          continue;
        }
        const s = 1 + age * 9;
        sw.mesh.scale.set(s, s, s);
        sw.mat.opacity = 0.75 * (1 - age) * (1 - age);
      }

      // floating HTML labels above heads
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      rigs.forEach((rig, i) => {
        const el = labelRefs.current[i];
        if (!el) return;
        rig.joints.head.getWorldPosition(tmpV);
        tmpV.y += 0.85;
        tmpV.project(camera);
        if (tmpV.z > 1) {
          el.style.opacity = "0";
          return;
        }
        const live = liveAgents[i];
        el.style.opacity = live?.status === "waiting" ? "0.45" : "0.95";
        el.style.transform = `translate(-50%, -100%) translate(${((tmpV.x + 1) / 2) * w}px, ${((-tmpV.y + 1) / 2) * h}px)`;
      });

      if (activeQuality === "eco") renderer.render(scene, camera);
      else composer.render();
    };
    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      systemReducedMotion = event.matches;
      lastFrameAt = 0;
      scheduleFrame();
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        gesture.cancel();
        dragging = false;
        suspendFrames();
      } else {
        pointerDirty = true;
        scheduleFrame();
      }
    };
    const sceneObserver = new IntersectionObserver(([entry]) => {
      sceneInView = entry.isIntersecting;
      if (sceneInView) scheduleFrame();
      else suspendFrames();
    });
    sceneObserver.observe(mount);
    motionPreference.addEventListener("change", onMotionPreferenceChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleFrame();

    // --- Cleanup ---
    return () => {
      sceneDisposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      sceneObserver.disconnect();
      motionPreference.removeEventListener("change", onMotionPreferenceChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      mount.removeEventListener("pointerdown", onPointerDown);
      mount.removeEventListener("pointermove", onPointerMove);
      mount.removeEventListener("pointerup", onPointerUp);
      mount.removeEventListener("pointercancel", onPointerCancel);
      mount.removeEventListener("lostpointercapture", onPointerCancel);
      mount.removeEventListener("pointerleave", onPointerLeave);
      mount.removeEventListener("wheel", onWheel);
      disposeObject(scene);
      glowTex.dispose();
      environmentTexture.dispose();
      composer.dispose();
      renderer.dispose();
      delete mount.dataset.sceneMotion;
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
    // Scene is built once; live status flows through propsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const supportAgents = agents.flatMap((parent, parentIndex) =>
    parent.supports.slice(0, 2).map((support, supportIndex) => ({
      ...support,
      parentIndex,
      supportIndex,
      color: parent.color,
      status: parent.status,
    }))
  );

  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    >
      <div ref={mountRef} style={{ position: "absolute", inset: 0, touchAction: "none" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {agents.map((a, i) => (
          <div
            key={a.id}
            ref={(el) => {
              labelRefs.current[i] = el;
            }}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              willChange: "transform",
              transition: "opacity 0.4s ease",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              fontFamily: "var(--font-mono, monospace)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.22em",
                color: a.color,
                textShadow: `0 0 12px ${a.color}88`,
              }}
            >
              {a.label.toUpperCase()}
            </span>
            <span
              style={{
                fontSize: 9,
                letterSpacing: "0.18em",
                color:
                  a.status === "running" || a.status === "done" || a.trainingActive
                    ? a.color
                    : "rgba(160,175,210,0.75)",
              }}
            >
              {a.status === "running" ? "▸ " : a.trainingActive ? "◇ " : ""}
              {a.trainingActive && a.status === "idle"
                ? `ADAPTING ${Math.round((a.trainingProgress ?? 0) * 100)}% · LV ${a.trainingLevel ?? 1}`
                : `${STATUS_TEXT[a.status]}${
                    a.status === "running" ? ` ${Math.round(a.progress * 100)}%` : ""
                  }`}
            </span>
          </div>
        ))}
        {supportAgents.map((support, flatIndex) => (
          <div
            key={`${support.parentIndex}-${support.id}`}
            ref={(el) => {
              supportLabelRefs.current[flatIndex] = el;
            }}
            title={support.role}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              willChange: "transform",
              transition: "opacity 0.35s ease",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 5px",
              borderRadius: 3,
              border: `1px solid ${support.color}33`,
              background: "rgba(7, 10, 13, 0.58)",
              color: support.color,
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 7,
              fontWeight: 700,
              letterSpacing: "0.13em",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            }}
          >
            <span style={{ opacity: 0.65 }}>↳</span>
            <span>{support.label.toUpperCase()}</span>
            <span style={{ opacity: 0.58 }}>LV {support.trainingLevel ?? 1}</span>
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: support.color,
                opacity: support.status === "running" ? 1 : 0.42,
                boxShadow:
                  support.status === "running"
                    ? `0 0 6px ${support.color}`
                    : "none",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
