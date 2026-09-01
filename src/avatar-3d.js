import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const HEAD_SHOT_HEIGHT_RATIO = 0.23;
const MAX_MOUTH_OPEN = 0.40;

const canvas = document.getElementById('avatar-canvas');
const loading = document.getElementById('avatar-loading');
const container = document.getElementById('ani-avatar');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
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
scene.add(lookTarget);
scene.add(new THREE.HemisphereLight(0xd8e4f0, 0x171523, 1.25));
const keyLight = new THREE.DirectionalLight(0xe4e8f2, 1.45);
keyLight.position.set(1.8, 2.8, 2.6);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x5579a8, 0.75);
rimLight.position.set(-2, 2, -1.5);
scene.add(rimLight);

let vrm = null;
let mouthOpen = 0;
let activeEmotion = null;
let blinkStart = -1;
let nextBlink = 2.4;
let activeEmotionValue = 0;
let cameraReturnTimer = null;
let cameraReturning = false;
let touchPoint = null;
const defaultCameraPosition = new THREE.Vector3();
const defaultCameraTarget = new THREE.Vector3();
const idleBones = {};
const emotionMap = {
  neutral: null,
  happy: ['happy', 0.45],
  sad: ['sad', 0.65],
  annoyed: ['angry', 0.55],
  curious: ['surprised', 0.3],
  shy: ['happy', 0.3],
};

function expression(name, value) {
  if (vrm?.expressionManager && name) vrm.expressionManager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
}

function setEmotion(name = 'neutral') {
  if (activeEmotion) expression(activeEmotion, 0);
  const selected = emotionMap[name] || null;
  activeEmotion = selected?.[0] || null;
  activeEmotionValue = selected?.[1] || 0;
  if (selected) expression(selected[0], selected[1]);
}

function setMouthOpen(value = 0) {
  mouthOpen = THREE.MathUtils.clamp((value - 0.16) / 1.09, 0, 1) * MAX_MOUTH_OPEN;
}

function tuneMaterials(model) {
  const visited = new Set();
  model.scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material || visited.has(material)) continue;
      visited.add(material);
      if (material.name.includes('EyeIris')) material.color?.setHex(0x4f8fc4);
      if (material.name.includes('HAIR') && material.emissive) {
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
  const leftUpperArm = bone('leftUpperArm');
  const rightUpperArm = bone('rightUpperArm');
  const leftLowerArm = bone('leftLowerArm');
  const rightLowerArm = bone('rightLowerArm');
  if (leftUpperArm) leftUpperArm.rotation.z -= 1.4;
  if (rightUpperArm) rightUpperArm.rotation.z += 1.4;
  if (leftLowerArm) leftLowerArm.rotation.z -= 0.03;
  if (rightLowerArm) rightLowerArm.rotation.z += 0.03;
  for (const name of ['spine', 'chest', 'head']) {
    const node = bone(name);
    if (node) idleBones[name] = { node, base: node.rotation.clone() };
  }
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const visibleHeight = size.y * HEAD_SHOT_HEIGHT_RATIO;
  const targetY = box.max.y - visibleHeight * 0.48;
  const distance = visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.04;
  defaultCameraTarget.set(center.x, targetY, center.z);
  defaultCameraPosition.set(center.x, targetY, center.z + distance);
  camera.position.copy(defaultCameraPosition);
  controls.target.copy(defaultCameraTarget);
  controls.minDistance = distance * 0.72;
  controls.maxDistance = distance * 1.45;
  controls.update();
  lookTarget.position.set(camera.position.x, box.max.y - size.y * 0.11, camera.position.z);
  if (model.lookAt) model.lookAt.target = lookTarget;
}

function scheduleCameraReturn(delay = 1300) {
  clearTimeout(cameraReturnTimer);
  cameraReturnTimer = setTimeout(() => { cameraReturning = true; }, delay);
}

controls.addEventListener('start', () => {
  clearTimeout(cameraReturnTimer);
  cameraReturning = false;
});
controls.addEventListener('end', () => scheduleCameraReturn());

function reactToTouch() {
  expression('happy', 0.95);
  setTimeout(() => {
    expression('happy', 0);
    if (activeEmotion) expression(activeEmotion, activeEmotionValue);
  }, 700);
}

canvas.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary) { touchPoint = null; return; }
  touchPoint = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), moved: false };
});
canvas.addEventListener('pointermove', (event) => {
  if (!touchPoint || event.pointerId !== touchPoint.id) return;
  if (Math.hypot(event.clientX - touchPoint.x, event.clientY - touchPoint.y) > 9) touchPoint.moved = true;
});
canvas.addEventListener('pointerup', (event) => {
  if (touchPoint && event.pointerId === touchPoint.id && !touchPoint.moved && performance.now() - touchPoint.at < 450) reactToTouch();
  touchPoint = null;
});
canvas.addEventListener('pointercancel', () => { touchPoint = null; });

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
loader.load('/models/ani.vrm', (gltf) => {
  vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.removeUnnecessaryJoints(gltf.scene);
  VRMUtils.rotateVRM0(vrm);
  tuneMaterials(vrm);
  poseNaturally(vrm);
  scene.add(vrm.scene);
  frameModel(vrm);
  setEmotion(container.className.match(/emotion-([\w-]+)/)?.[1] || 'neutral');
  loading.hidden = true;
  container.classList.add('avatar-ready');
}, (event) => {
  if (event.total) loading.textContent = `Chargement d’Ani… ${Math.round(event.loaded / event.total * 100)}%`;
}, (error) => {
  console.error('Impossible de charger Ani VRM', error);
  loading.textContent = 'Avatar 3D indisponible';
  loading.classList.add('error');
});

function updateBlink(elapsed) {
  if (blinkStart < 0 && elapsed >= nextBlink) blinkStart = elapsed;
  if (blinkStart < 0) return;
  const progress = (elapsed - blinkStart) / 0.16;
  if (progress >= 1) {
    expression('blink', 0);
    blinkStart = -1;
    nextBlink = elapsed + 2.4 + Math.random() * 3.8;
  } else expression('blink', Math.sin(progress * Math.PI));
}

function updateMouth(elapsed) {
  if (mouthOpen < 0.025) {
    expression('aa', 0); expression('ih', 0); expression('ou', 0); return;
  }
  const phase = Math.floor(elapsed * 9) % 3;
  expression('aa', mouthOpen * (phase === 0 ? 0.82 : 0.48));
  expression('ih', mouthOpen * 0.08);
  expression('ou', mouthOpen * (phase === 2 ? 0.24 : 0.02));
}

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;
  if (cameraReturning) {
    const blend = 1 - Math.exp(-delta * 4.2);
    camera.position.lerp(defaultCameraPosition, blend);
    controls.target.lerp(defaultCameraTarget, blend);
    if (camera.position.distanceTo(defaultCameraPosition) < 0.002 && controls.target.distanceTo(defaultCameraTarget) < 0.002) {
      camera.position.copy(defaultCameraPosition);
      controls.target.copy(defaultCameraTarget);
      cameraReturning = false;
    }
  }
  controls.update();
  if (vrm) {
    updateBlink(elapsed);
    updateMouth(elapsed);
    for (const { node, base } of Object.values(idleBones)) node.rotation.copy(base);
    if (idleBones.spine) idleBones.spine.node.rotation.z += Math.sin(elapsed * 0.7) * 0.012;
    if (idleBones.chest) idleBones.chest.node.rotation.x += Math.sin(elapsed * 0.5) * 0.008;
    if (idleBones.head) {
      idleBones.head.node.rotation.y += Math.sin(elapsed * 0.36) * 0.035;
      idleBones.head.node.rotation.x += Math.sin(elapsed * 0.51) * 0.012;
    }
    vrm.update(delta);
  }
  renderer.render(scene, camera);
});

function getCameraState() {
  return { position: camera.position.toArray(), target: controls.target.toArray() };
}

window.aniAvatar = { setEmotion, setMouthOpen, reactToTouch, getCameraState };
