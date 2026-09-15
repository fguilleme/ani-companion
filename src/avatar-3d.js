import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const UPPER_BODY_HEIGHT_RATIO = 0.38;
const UPPER_BODY_VERTICAL_OFFSET = 0.1;
const UPPER_BODY_FRAME_MARGIN = 1.02;
const FULL_BODY_FRAME_MARGIN = 1.18;
const ACTION_CAMERA_VERTICAL_OFFSET = 0.25;
const MAX_MOUTH_OPEN = 0.4;

const canvas = document.getElementById("avatar-canvas");
const loading = document.getElementById("avatar-loading");
const container = document.getElementById("ani-avatar");
const motionIndicator = document.getElementById("motion-indicator");
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
scene.add(camera);
const clock = new THREE.Clock();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.75;
controls.minPolarAngle = Math.PI * 0.32;
controls.maxPolarAngle = Math.PI * 0.68;
const lookTarget = new THREE.Object3D();
const lightTarget = new THREE.Object3D();
scene.add(lookTarget, lightTarget);
scene.add(new THREE.HemisphereLight(0xd8e4f0, 0x171523, 1.25));
const keyLight = new THREE.DirectionalLight(0xe4e8f2, 1.45);
keyLight.position.set(1.8, 2.8, 2.6);
keyLight.target = lightTarget;
const rimLight = new THREE.DirectionalLight(0x5579a8, 0.75);
rimLight.position.set(-2, 2, -1.5);
rimLight.target = lightTarget;
const fillLight = new THREE.DirectionalLight(0xffdce8, 1.05);
fillLight.position.set(-1.4, 1.4, 2.5);
fillLight.target = lightTarget;
const lowerFillLight = new THREE.PointLight(0xffd6e4, 40, 2.4, 2);
lowerFillLight.position.set(0, -0.9, -0.35);
camera.add(keyLight, rimLight, fillLight, lowerFillLight);

let vrm = null;
let mouthOpen = 0;
let activeEmotion = null;
let blinkStart = -1;
let nextBlink = 2.4;
let activeEmotionValue = 0;
let cameraReturnTimer = null;
let cameraReturning = false;
let touchPoint = null;
let activeMotion = null;
let motionStartedAt = 0;
let motionCameraActive = false;
const defaultCameraPosition = new THREE.Vector3();
const defaultCameraTarget = new THREE.Vector3();
const actionCameraPosition = new THREE.Vector3();
const actionCameraTarget = new THREE.Vector3();
let defaultCameraFov = camera.fov;
let actionCameraFov = camera.fov;
const baseAvatarPosition = new THREE.Vector3();
const baseAvatarRotation = new THREE.Euler();
const idleBones = {};
const glbMouthBones = {};
const glbMouthBoneNames = {
  control: "CTRL_Mouth",
  upperLip: "MCH_Lip_Upper",
  lowerLip: "MCH_Lip_Lower",
  leftCorner: "MCH_MouthCorner.L",
  rightCorner: "MCH_MouthCorner.R",
  jaw: "MCH_Jaw",
};
const emotionMap = {
  neutral: null,
  happy: ["happy", 0.72],
  sad: ["sad", 0.8],
  angry: ["angry", 0.7],
  annoyed: ["angry", 0.7],
  curious: ["surprised", 0.58],
  shy: ["relaxed", 0.5],
};
const motionDurations = {
  dance: 10000,
  spin: 4500,
  jump: 3500,
  sway: 3200,
  tease: 3000,
};
const moodExpressions = ["happy", "sad", "angry", "surprised", "relaxed"];

function showMotionName(name = "") {
  if (!motionIndicator) return;
  motionIndicator.textContent = name;
  motionIndicator.hidden = !name;
}

function expression(name, value) {
  if (vrm?.expressionManager && name)
    vrm.expressionManager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
}

function setEmotion(name = "neutral") {
  if (activeEmotion) expression(activeEmotion, 0);
  const selected = emotionMap[name] || null;
  activeEmotion = selected?.[0] || null;
  activeEmotionValue = selected?.[1] || 0;
  if (selected) expression(selected[0], selected[1]);
}

function setMouthOpen(value = 0) {
  mouthOpen =
    THREE.MathUtils.clamp((value - 0.16) / 1.09, 0, 1) * MAX_MOUTH_OPEN;
}

function tuneMaterials(model) {
  const visited = new Set();
  model.scene.traverse((object) => {
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      if (!material || visited.has(material)) continue;
      visited.add(material);
      if (material.name.includes("EyeIris")) {
        material.color?.setHex(0x6ee7b7);
        if (material.emissive) {
          material.emissive.setHex(0x34d399);
          material.emissiveIntensity = 0.16;
        }
      }
      if (material.name.includes("HAIR") && material.emissive) {
        material.color.multiplyScalar(0.72);
        material.emissive.multiplyScalar(0.18);
        material.emissiveIntensity = 0.35;
      }
      material.needsUpdate = true;
    }
  });
}

function poseNaturally(model) {
  const bone = (name) => model.humanoid?.getNormalizedBoneNode(name) || null;
  const leftUpperArm = bone("leftUpperArm");
  const rightUpperArm = bone("rightUpperArm");
  const leftLowerArm = bone("leftLowerArm");
  const rightLowerArm = bone("rightLowerArm");
  if (leftUpperArm) leftUpperArm.rotation.z -= 1.4;
  if (rightUpperArm) rightUpperArm.rotation.z += 1.4;
  if (leftLowerArm) leftLowerArm.rotation.z -= 0.03;
  if (rightLowerArm) rightLowerArm.rotation.z += 0.03;
  for (const name of [
    "hips",
    "spine",
    "chest",
    "head",
    "leftUpperArm",
    "rightUpperArm",
    "leftLowerArm",
    "rightLowerArm",
  ]) {
    const node = bone(name);
    if (node) idleBones[name] = { node, base: node.rotation.clone() };
  }
}

function fittedVerticalFov(verticalSpan, distance, margin) {
  const radians = 2 * Math.atan((verticalSpan * margin) / (2 * distance));
  return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(radians), 20, 82);
}

function frameModel(model) {
  model.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const upperBodyHeight = size.y * UPPER_BODY_HEIGHT_RATIO;
  const upperTargetY = box.max.y - upperBodyHeight * 0.5;
  const defaultDistance = 1;
  defaultCameraTarget.set(
    center.x,
    upperTargetY + UPPER_BODY_VERTICAL_OFFSET,
    center.z,
  );
  defaultCameraPosition.set(
    center.x,
    upperTargetY + UPPER_BODY_VERTICAL_OFFSET,
    center.z + defaultDistance,
  );
  defaultCameraFov = fittedVerticalFov(
    upperBodyHeight,
    defaultDistance,
    UPPER_BODY_FRAME_MARGIN,
  );

  const actionDistance = 2;
  const fullBodySpan = Math.max(size.y, size.x / Math.max(camera.aspect, 0.25));
  actionCameraTarget.set(
    center.x,
    center.y + ACTION_CAMERA_VERTICAL_OFFSET,
    center.z,
  );
  actionCameraPosition.set(
    center.x,
    center.y + ACTION_CAMERA_VERTICAL_OFFSET,
    center.z + actionDistance,
  );
  actionCameraFov = fittedVerticalFov(
    fullBodySpan + 2 * ACTION_CAMERA_VERTICAL_OFFSET,
    actionDistance,
    FULL_BODY_FRAME_MARGIN,
  );

  camera.position.copy(defaultCameraPosition);
  camera.fov = defaultCameraFov;
  camera.updateProjectionMatrix();
  controls.target.copy(defaultCameraTarget);
  controls.minDistance = defaultDistance * 0.72;
  controls.maxDistance = actionDistance * 1.15;
  controls.update();
  lookTarget.position.set(
    camera.position.x,
    box.max.y - size.y * 0.11,
    camera.position.z,
  );
  if (model.lookAt) model.lookAt.target = lookTarget;
}

function scheduleCameraReturn(delay = 1300) {
  clearTimeout(cameraReturnTimer);
  cameraReturnTimer = setTimeout(() => {
    cameraReturning = true;
  }, delay);
}

controls.addEventListener("start", () => {
  clearTimeout(cameraReturnTimer);
  cameraReturning = false;
});
controls.addEventListener("end", () => scheduleCameraReturn());

function reactToTouch() {
  expression("happy", 0.95);
  setTimeout(() => {
    expression("happy", 0);
    if (activeEmotion) expression(activeEmotion, activeEmotionValue);
  }, 700);
}

canvas.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary) {
    touchPoint = null;
    return;
  }
  touchPoint = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
    moved: false,
  };
});
canvas.addEventListener("pointermove", (event) => {
  if (!touchPoint || event.pointerId !== touchPoint.id) return;
  if (
    Math.hypot(event.clientX - touchPoint.x, event.clientY - touchPoint.y) > 9
  )
    touchPoint.moved = true;
});
canvas.addEventListener("pointerup", (event) => {
  if (
    touchPoint &&
    event.pointerId === touchPoint.id &&
    !touchPoint.moved &&
    performance.now() - touchPoint.at < 450
  )
    reactToTouch();
  touchPoint = null;
});
canvas.addEventListener("pointercancel", () => {
  touchPoint = null;
});

function resize() {
  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
let glbAnimations = [];
let mixer = null;
let activeClip = null;
let glbIdleClip = null;
const danceClipPattern =
  /(?:dance|dancing|groove|shuffle)|^(?:Bass_Beats|Crystal_Beads|Dont_You_Dare|Squat_Stance)$/i;
const excludedMotionClips = new Set(["Boom_Dance"]);

function playGlbClip(
  name,
  { once = false, durationMs = 0, random = false } = {},
) {
  if (!mixer) return false;
  const candidates = random
    ? glbAnimations.filter(
        (clip) =>
          danceClipPattern.test(clip.name) &&
          !excludedMotionClips.has(clip.name),
      )
    : glbAnimations.filter((clip) =>
        clip.name.toLowerCase().includes(name.toLowerCase()),
      );
  const clip = random
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : candidates[0];
  if (!clip) return false;
  const action = mixer.clipAction(clip);
  mixer.stopAllAction();
  action.reset();
  action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat);
  action.clampWhenFinished = once;
  if (durationMs > 0) action.setDuration(durationMs / 1000);
  action.play();
  activeClip = action;
  return true;
}

const AVATAR_LOAD_MAX_ATTEMPTS = 3;
let avatarLoadGeneration = 0;

function reportAvatarLoad(event, detail = "") {
  fetch("/api/audio/timing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, detail: String(detail).slice(0, 500) }),
    keepalive: true,
  }).catch(() => {});
}

function loadAvatar(file) {
  const safe = /^[\w][\w .()-]*\.(vrm|glb)$/i.test(file) ? file : "Melissa.glb";
  const isGlb = safe.toLowerCase().endsWith(".glb");
  const generation = ++avatarLoadGeneration;
  renderer.toneMappingExposure = isGlb ? 1.0 : 0.68;
  keyLight.intensity = isGlb ? 1.45 : 0.75;
  fillLight.intensity = isGlb ? 1.05 : 0.35;
  lowerFillLight.intensity = isGlb ? 40 : 2;
  loading.hidden = false;
  loading.classList.remove("error");
  loading.textContent = "Chargement d’Ani…";
  container.classList.remove("avatar-ready");

  const tryLoad = (attempt) => {
    const retryQuery = attempt > 1 ? `?retry=${Date.now()}-${attempt}` : "";
    loader.load(
      `/models/${encodeURIComponent(safe)}${retryQuery}`,
      (gltf) => {
        if (generation !== avatarLoadGeneration) return;
        reportAvatarLoad("avatar.load.success", `${safe}:attempt=${attempt}`);
      document.body.classList.remove("avatar-motion-active");
      showMotionName();
      if (vrm) {
        scene.remove(vrm.scene);
        vrm = null;
      }
      if (mixer) {
        mixer.stopAllAction();
        mixer = null;
      }
      glbAnimations = [];
      activeClip = null;
      for (const { node } of Object.values(idleBones)) {
        node.rotation.set(0, 0, 0);
      }
      for (const key of Object.keys(idleBones)) delete idleBones[key];
      for (const key of Object.keys(glbMouthBones)) delete glbMouthBones[key];

      if (isGlb) {
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        tuneGlbMaterials(gltf.scene);
        glbAnimations = gltf.animations || [];
        if (glbAnimations.length) {
          mixer = new THREE.AnimationMixer(gltf.scene);
          const idleName = glbAnimations.find((clip) =>
            /idle|breath/i.test(clip.name),
          );
          if (idleName) {
            glbIdleClip = idleName;
            mixer.clipAction(idleName).play();
          }
        }
        gltf.scene.traverse((object) => {
          if (object.isBone) {
            const normalizedObjectName = object.name
              .replace(/[._]/g, "")
              .toLowerCase();
            for (const [key, boneName] of Object.entries(glbMouthBoneNames)) {
              if (
                normalizedObjectName ===
                boneName.replace(/[._]/g, "").toLowerCase()
              ) {
                glbMouthBones[key] = {
                  node: object,
                  basePosition: object.position.clone(),
                  baseQuaternion: object.quaternion.clone(),
                };
              }
            }
          }
          if (
            object.isBone &&
            /head/i.test(object.name) &&
            !/end|front/i.test(object.name)
          ) {
            idleBones.head = { node: object, base: object.rotation.clone() };
          }
          if (object.isBone && /neck/i.test(object.name)) {
            idleBones.neck = { node: object, base: object.rotation.clone() };
          }
          if (
            object.isBone &&
            /spine0?2|chest/i.test(object.name) &&
            !idleBones.chest
          ) {
            idleBones.chest = { node: object, base: object.rotation.clone() };
          }
        });
        gltf.scene.updateMatrixWorld(true);
        baseAvatarPosition.copy(gltf.scene.position);
        baseAvatarRotation.copy(gltf.scene.rotation);
        scene.add(gltf.scene);
        vrm = makeGlbLikeVrm(gltf);
        frameModel(vrm);
      } else {
        vrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        VRMUtils.rotateVRM0(vrm);
        baseAvatarPosition.copy(vrm.scene.position);
        baseAvatarRotation.copy(vrm.scene.rotation);
        tuneMaterials(vrm);
        poseNaturally(vrm);
        scene.add(vrm.scene);
        frameModel(vrm);
      }
      setEmotion(
        container.className.match(/emotion-([\w-]+)/)?.[1] || "neutral",
      );
      loading.hidden = true;
      container.classList.add("avatar-ready");
      },
      (event) => {
        if (generation !== avatarLoadGeneration) return;
        if (event.total)
          loading.textContent = `Chargement d’Ani… ${Math.round((event.loaded / event.total) * 100)}%`;
      },
      (error) => {
        if (generation !== avatarLoadGeneration) return;
        const reason = error?.message || error?.type || error?.statusText || "erreur inconnue";
        console.warn(`Échec du chargement de l’avatar (tentative ${attempt})`, error);
        if (attempt < AVATAR_LOAD_MAX_ATTEMPTS) {
          reportAvatarLoad("avatar.load.retry", `${safe}:attempt=${attempt}:${reason}`);
          loading.textContent = `Chargement d’Ani… nouvelle tentative ${attempt + 1}/${AVATAR_LOAD_MAX_ATTEMPTS}`;
          window.setTimeout(() => {
            if (generation === avatarLoadGeneration) tryLoad(attempt + 1);
          }, attempt * 750);
          return;
        }
        reportAvatarLoad("avatar.load.failed", `${safe}:attempt=${attempt}:${reason}`);
        console.error("Impossible de charger l’avatar après plusieurs tentatives", error);
        loading.textContent = "Avatar 3D indisponible — toucher pour réessayer";
        loading.classList.add("error");
        loading.onclick = () => loadAvatar(safe);
      },
    );
  };

  loading.onclick = null;
  tryLoad(1);
}

function tuneGlbMaterials(scene) {
  // Melissa's atlas already contains its authored lighting. Render it like Quick Look
  // instead of applying PBR lights, emissive color, and ACES a second time.
  const converted = new Map();
  const convert = (material) => {
    if (!material) return material;
    if (converted.has(material)) return converted.get(material);
    const previewMaterial = new THREE.MeshBasicMaterial({
      name: material.name,
      map: material.map || material.emissiveMap,
      color: material.color?.clone?.() || new THREE.Color(0xffffff),
      transparent: material.transparent,
      opacity: material.opacity,
      alphaMap: material.alphaMap,
      alphaTest: material.alphaTest,
      side: material.side,
      depthWrite: material.depthWrite,
      vertexColors: material.vertexColors,
    });
    previewMaterial.toneMapped = false;
    previewMaterial.needsUpdate = true;
    converted.set(material, previewMaterial);
    return previewMaterial;
  };
  scene.traverse((object) => {
    if (!object.isMesh) return;
    if (Array.isArray(object.material))
      object.material = object.material.map(convert);
    else {
      const previewMaterial = convert(object.material);
      object.material = previewMaterial;
    }
  });
}

function makeGlbLikeVrm(gltf) {
  // Adapt a GLB rig to the vrm-shaped API used by the render loop.
  const bonesByName = {};
  gltf.scene.traverse((object) => {
    if (object.isBone) bonesByName[object.name.toLowerCase()] = object;
  });
  const pick = (...names) => {
    for (const name of names) {
      if (bonesByName[name]) return bonesByName[name];
      const partial = Object.keys(bonesByName).find((key) =>
        key.includes(name.toLowerCase()),
      );
      if (partial) return bonesByName[partial];
    }
    return null;
  };
  const humanoid = {
    getNormalizedBoneNode: (name) =>
      pick(
        name,
        name.toLowerCase(),
        name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(),
        name.replace(/([a-z])([A-Z])/g, "$1$2").toLowerCase(),
      ) || null,
  };
  return {
    scene: gltf.scene,
    humanoid,
    expressionManager: null,
    lookAt: null,
    update: (delta) => {
      if (mixer) mixer.update(delta);
    },
  };
}

function currentAvatarFile() {
  try {
    const profile = localStorage.getItem("ani.profile") || "";
    return localStorage.getItem(`ani.avatar.${profile}`) || "Melissa.glb";
  } catch (_) {
    return "Melissa.glb";
  }
}
loadAvatar(currentAvatarFile());

function updateBlink(elapsed) {
  if (blinkStart < 0 && elapsed >= nextBlink) blinkStart = elapsed;
  if (blinkStart < 0) return;
  const progress = (elapsed - blinkStart) / 0.16;
  if (progress >= 1) {
    expression("blink", 0);
    blinkStart = -1;
    nextBlink = elapsed + 2.4 + Math.random() * 3.8;
  } else expression("blink", Math.sin(progress * Math.PI));
}

function updateMouth(elapsed) {
  if (mouthOpen < 0.025) {
    expression("aa", 0);
    expression("ih", 0);
    expression("ou", 0);
    return;
  }
  const phase = Math.floor(elapsed * 9) % 3;
  expression("aa", mouthOpen * (phase === 0 ? 0.82 : 0.48));
  expression("ih", mouthOpen * 0.08);
  expression("ou", mouthOpen * (phase === 2 ? 0.24 : 0.02));
}

function applyGlbMouthMotion() {
  if (!glbMouthBones.lowerLip || !glbMouthBones.upperLip || !glbMouthBones.jaw)
    return;
  for (const { node, basePosition, baseQuaternion } of Object.values(
    glbMouthBones,
  )) {
    node.position.copy(basePosition);
    node.quaternion.copy(baseQuaternion);
  }
  const openness = THREE.MathUtils.clamp(mouthOpen / MAX_MOUTH_OPEN, 0, 1);
  const speechOpen = Math.sqrt(openness);
  glbMouthBones.lowerLip.node.position.z -= speechOpen * 1.25;
  glbMouthBones.jaw.node.position.z -= speechOpen * 0.3;
}

function playMotion(name) {
  if (
    !motionDurations[name] ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return false;
  const clipMap = {
    dance: "dance",
    spin: "turn",
    jump: "hop_with_arms_raised",
    sway: "sway",
  };
  const proceduralOnly = name === "tease";
  if (proceduralOnly) restoreGlbIdle();
  if (
    !proceduralOnly &&
    glbAnimations.length &&
    playGlbClip(clipMap[name] || name, {
      once: true,
      durationMs: motionDurations[name],
      random: name === "dance",
    })
  ) {
    activeMotion = name;
    showMotionName(activeClip?.getClip().name || name);
    document.body.classList.add("avatar-motion-active");
    motionStartedAt = performance.now();
    motionCameraActive = ["dance", "spin", "jump"].includes(name);
    cameraReturning = !motionCameraActive;
    return true;
  }
  activeMotion = name;
  showMotionName(name);
  document.body.classList.add("avatar-motion-active");
  motionStartedAt = performance.now();
  motionCameraActive = ["dance", "spin", "jump"].includes(name);
  cameraReturning = !motionCameraActive;
  return true;
}

function restoreGlbIdle() {
  if (!mixer || !activeClip) return;
  activeClip.stop();
  activeClip = null;
  if (glbIdleClip) mixer.clipAction(glbIdleClip).reset().play();
}

function applySpeakingMotion(elapsed) {
  const bobAmount = mouthOpen > 0.025 ? 1 : 0;
  if (idleBones.head) {
    idleBones.head.node.rotation.x +=
      Math.sin(elapsed * 2.6) * 0.018 * (bobAmount ? 1.6 : 1);
    idleBones.head.node.rotation.y += Math.sin(elapsed * 1.9) * 0.025;
    idleBones.head.node.rotation.z += Math.sin(elapsed * 1.3) * 0.008;
    if (bobAmount)
      idleBones.head.node.rotation.x += Math.sin(elapsed * 9.4) * 0.02;
  }
  if (bobAmount && idleBones.neck) {
    idleBones.neck.node.rotation.x += Math.sin(elapsed * 9.4 + 0.7) * 0.014;
  }
  if (bobAmount && idleBones.chest) {
    idleBones.chest.node.rotation.x += Math.sin(elapsed * 4.7) * 0.012;
    idleBones.chest.node.rotation.y += Math.sin(elapsed * 1.5) * 0.01;
  }
}

function applyActiveMotion(now) {
  if (!activeMotion) return;
  const progress = (now - motionStartedAt) / motionDurations[activeMotion];
  if (progress >= 1) {
    activeMotion = null;
    showMotionName();
    document.body.classList.remove("avatar-motion-active");
    restoreGlbIdle();
    if (motionCameraActive) {
      motionCameraActive = false;
      cameraReturning = true;
    }
    return;
  }
  const wave = Math.sin(progress * Math.PI * 8);
  if (activeMotion === "spin") {
    vrm.scene.rotation.y += progress * Math.PI * 2;
  } else if (activeMotion === "jump") {
    vrm.scene.position.y += Math.sin(progress * Math.PI) * 0.1;
    if (idleBones.leftUpperArm)
      idleBones.leftUpperArm.node.rotation.x -=
        Math.sin(progress * Math.PI) * 0.55;
    if (idleBones.rightUpperArm)
      idleBones.rightUpperArm.node.rotation.x -=
        Math.sin(progress * Math.PI) * 0.55;
  } else if (activeMotion === "sway") {
    if (idleBones.hips)
      idleBones.hips.node.rotation.z += Math.sin(progress * Math.PI * 4) * 0.07;
    if (idleBones.chest)
      idleBones.chest.node.rotation.z -=
        Math.sin(progress * Math.PI * 4) * 0.045;
    if (idleBones.head)
      idleBones.head.node.rotation.z +=
        Math.sin(progress * Math.PI * 4) * 0.035;
  } else if (activeMotion === "tease") {
    if (idleBones.head) {
      idleBones.head.node.rotation.z += Math.sin(progress * Math.PI) * 0.13;
      idleBones.head.node.rotation.x -=
        Math.sin(progress * Math.PI * 2) * 0.035;
    }
    if (idleBones.chest)
      idleBones.chest.node.rotation.y += Math.sin(progress * Math.PI) * 0.06;
  } else if (activeMotion === "dance") {
    vrm.scene.position.y += Math.abs(wave) * 0.025;
    if (idleBones.hips) idleBones.hips.node.rotation.z += wave * 0.09;
    if (idleBones.chest) idleBones.chest.node.rotation.z -= wave * 0.07;
    if (idleBones.head)
      idleBones.head.node.rotation.y += Math.sin(progress * Math.PI * 6) * 0.12;
    if (idleBones.leftUpperArm)
      idleBones.leftUpperArm.node.rotation.x += wave * 0.42;
    if (idleBones.rightUpperArm)
      idleBones.rightUpperArm.node.rotation.x -= wave * 0.42;
  }
}

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;
  if (motionCameraActive) {
    const blend = 1 - Math.exp(-delta * 1.6);
    camera.position.lerp(actionCameraPosition, blend);
    controls.target.lerp(actionCameraTarget, blend);
    camera.fov = THREE.MathUtils.lerp(camera.fov, actionCameraFov, blend);
    camera.updateProjectionMatrix();
  } else if (cameraReturning) {
    const blend = 1 - Math.exp(-delta * 1.6);
    camera.position.lerp(defaultCameraPosition, blend);
    controls.target.lerp(defaultCameraTarget, blend);
    camera.fov = THREE.MathUtils.lerp(camera.fov, defaultCameraFov, blend);
    camera.updateProjectionMatrix();
    if (
      camera.position.distanceTo(defaultCameraPosition) < 0.002 &&
      controls.target.distanceTo(defaultCameraTarget) < 0.002 &&
      Math.abs(camera.fov - defaultCameraFov) < 0.02
    ) {
      camera.position.copy(defaultCameraPosition);
      controls.target.copy(defaultCameraTarget);
      camera.fov = defaultCameraFov;
      camera.updateProjectionMatrix();
      cameraReturning = false;
    }
  }
  controls.update();
  lightTarget.position.copy(controls.target);
  if (vrm) {
    updateBlink(elapsed);
    updateMouth(elapsed);
    vrm.scene.position.copy(baseAvatarPosition);
    vrm.scene.rotation.copy(baseAvatarRotation);
    for (const { node, base } of Object.values(idleBones))
      node.rotation.copy(base);
    if (idleBones.spine)
      idleBones.spine.node.rotation.z += Math.sin(elapsed * 0.7) * 0.012;
    if (idleBones.chest)
      idleBones.chest.node.rotation.x += Math.sin(elapsed * 0.5) * 0.008;
    if (idleBones.head) {
      idleBones.head.node.rotation.y += Math.sin(elapsed * 0.36) * 0.035;
      idleBones.head.node.rotation.x += Math.sin(elapsed * 0.51) * 0.012;
    }
    applySpeakingMotion(elapsed);
    applyActiveMotion(performance.now());
    vrm.update(delta);
    applyGlbMouthMotion(elapsed);
  }
  renderer.render(scene, camera);
});

function getCameraState() {
  return {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
  };
}

function getLightingState() {
  scene.updateMatrixWorld(true);
  return {
    key: keyLight.getWorldPosition(new THREE.Vector3()).toArray(),
    rim: rimLight.getWorldPosition(new THREE.Vector3()).toArray(),
    lowerFill: lowerFillLight.getWorldPosition(new THREE.Vector3()).toArray(),
    target: lightTarget.getWorldPosition(new THREE.Vector3()).toArray(),
  };
}

function getFramingState() {
  if (!vrm) return { mode: "loading", fov: camera.fov, boundsNdc: null };
  vrm.scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const points = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z])
        points.push(new THREE.Vector3(x, y, z).project(camera));
    }
  }
  return {
    mode: motionCameraActive ? "full-body" : "upper-body",
    fov: camera.fov,
    boundsNdc: {
      minX: Math.min(...points.map((point) => point.x)),
      maxX: Math.max(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxY: Math.max(...points.map((point) => point.y)),
    },
  };
}

function getAnimationState() {
  const values = {};
  for (const name of moodExpressions)
    values[name] = vrm?.expressionManager?.getValue(name) || 0;
  return {
    ready: Boolean(vrm),
    activeMotion,
    activeClip: activeClip?.getClip().name || null,
    emotion: activeEmotion,
    expressions: values,
    headRotation: idleBones.head
      ? [
          idleBones.head.node.rotation.x,
          idleBones.head.node.rotation.y,
          idleBones.head.node.rotation.z,
        ]
      : null,
    avatarPosition: vrm?.scene.position.toArray() || null,
    avatarRotation: vrm
      ? [vrm.scene.rotation.x, vrm.scene.rotation.y, vrm.scene.rotation.z]
      : null,
  };
}

function getMouthRigState() {
  const bones = Object.keys(glbMouthBones);
  return {
    available: bones.length === Object.keys(glbMouthBoneNames).length,
    bones,
    upperLip: glbMouthBones.upperLip?.node.position.toArray() || null,
    lowerLip: glbMouthBones.lowerLip?.node.position.toArray() || null,
    jaw: glbMouthBones.jaw?.node.position.toArray() || null,
  };
}

function getMotionCatalog() {
  return {
    dance: glbAnimations
      .filter((clip) => danceClipPattern.test(clip.name) && !excludedMotionClips.has(clip.name))
      .map((clip) => clip.name),
  };
}

window.aniAvatar = {
  setEmotion,
  setMouthOpen,
  playMotion,
  reactToTouch,
  getCameraState,
  getLightingState,
  getFramingState,
  getAnimationState,
  getMouthRigState,
  getMotionCatalog,
};
