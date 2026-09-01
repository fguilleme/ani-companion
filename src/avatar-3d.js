import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const canvas = document.getElementById('avatar-canvas');
const loading = document.getElementById('avatar-loading');
const container = document.getElementById('ani-avatar');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
const clock = new THREE.Clock();
const lookTarget = new THREE.Object3D();
scene.add(lookTarget);
scene.add(new THREE.HemisphereLight(0xfff1e8, 0x382c45, 2.2));
const keyLight = new THREE.DirectionalLight(0xfff4e9, 2.4);
keyLight.position.set(1.8, 2.8, 2.6);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x72c9ff, 1.4);
rimLight.position.set(-2, 2, -1.5);
scene.add(rimLight);

let vrm = null;
let mouthOpen = 0;
let activeEmotion = null;
let blinkStart = -1;
let nextBlink = 2.4;
const idleBones = {};
const emotionMap = {
  neutral: null,
  happy: ['happy', 0.72],
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
  if (selected) expression(selected[0], selected[1]);
}

function setMouthOpen(value = 0) {
  mouthOpen = THREE.MathUtils.clamp((value - 0.16) / 1.09, 0, 1);
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
  const distance = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.04;
  camera.position.set(center.x, center.y + size.y * 0.015, center.z + distance);
  camera.lookAt(center.x, center.y + size.y * 0.015, center.z);
  lookTarget.position.set(camera.position.x, center.y + size.y * 0.18, camera.position.z);
  if (model.lookAt) model.lookAt.target = lookTarget;
}

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
  const phase = Math.floor(elapsed * 11) % 3;
  expression('aa', mouthOpen * (phase === 0 ? 0.95 : 0.58));
  expression('ih', mouthOpen * (phase === 1 ? 0.38 : 0.03));
  expression('ou', mouthOpen * (phase === 2 ? 0.4 : 0.03));
}

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;
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

window.aniAvatar = { setEmotion, setMouthOpen };
