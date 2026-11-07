import * as THREE from 'three/webgpu';
import { CITY_LANDMARKS } from './city-config.js';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: 'Persecución',                   category: 'follow', fov: 56 },
  { id: 'action',      name: 'Contrapicado',                  category: 'follow', fov: 60 },
  { id: 'pov',         name: 'Primera persona / cabina',      category: 'follow', fov: 68 },
  { id: 'micalet',     name: 'Catedral & el Micalet',         category: 'scenic', fov: 50 },
  { id: 'ajuntament',  name: "Plaça de l'Ajuntament",         category: 'scenic', fov: 52 },
  { id: 'serrans',     name: 'Torres dels Serrans',           category: 'scenic', fov: 50 },
  { id: 'turia',       name: 'Jardí del Túria',               category: 'scenic', fov: 56 },
  { id: 'cac',         name: 'Ciutat de les Arts i les Ciències', category: 'scenic', fov: 50 },
  { id: 'port',        name: 'La Marina & Veles e Vents',     category: 'scenic', fov: 50 },
  { id: 'beach',       name: 'Platja de la Malva-rosa',       category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Dron automático',               category: 'scenic', fov: 50 }
];
// Where each scenic camera looks from: the landmarks' real places (city-config.js CITY_LANDMARKS)
const SITE = Object.fromEntries(CITY_LANDMARKS.map((l) => [l.id, l]));

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    // ('fixed' is the ?debug still camera: not in the cycle or the menus)
    const preset = presetId === 'fixed' ? { id: 'fixed', fov: 50 } : CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'scooter') {
          fwdOffset = 0.2;
          eyeY = 1.78;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'micalet': {
        // From Plaça de la Reina up the cathedral's baroque door to the Micalet's belfry
        const sway = Math.sin(elapsed * 0.22) * 4.0;
        // (from the square's south end: the real buildings close in on every other side)
        const m = SITE.micalet;
        desiredPos.set(m.x - 52.0 + sway, 9.0, m.z + 160.0);
        desiredLook.set(m.x, 34.0, m.z);
        break;
      }

      case 'ajuntament': {
        // Over the square's fountain & flower stalls, the town hall & Correus around it
        const pan = Math.sin(elapsed * 0.16) * 60.0;
        // from above the square's south end, up its length past the town hall to Correus
        const c = SITE.ajuntament;
        desiredPos.set(c.x - 35.0, 32.0, c.z + 45.0);
        desiredLook.set(c.x + 85.0 + pan, 8.0, c.z - 230.0);
        break;
      }

      case 'serrans': {
        // From across the Turia's old bed at the city gate's twin towers
        const sway = Math.sin(elapsed * 0.25) * 2.0;
        // from the Pont dels Serrans
        const s = SITE.serrans;
        desiredPos.set(s.x + 130.0 + sway, 10.0, s.z - 75.0);
        desiredLook.set(s.x, 20.0, s.z);
        break;
      }

      case 'turia': {
        // Low along the garden in the old riverbed by Gulliver, the bridges overhead
        const drift = Math.sin(elapsed * 0.12) * 40.0;
        const g = SITE.gulliver;
        desiredPos.set(g.x - 120.0 + drift, 14.0, g.z - 260.0);
        desiredLook.set(g.x + 60.0, 6.0, g.z + 200.0);
        break;
      }

      case 'cac': {
        // Over the pools at Calatrava's white city: the Hemisfèric's eye, the Palau de les Arts' plume beyond
        const drift = Math.sin(elapsed * 0.12) * 50.0;
        // at the pool's edge on the Hemisfèric's east side, l'Umbracle's arches behind it (reference/v08-cac-2)
        const h = SITE.cac;
        desiredPos.set(h.x + 95.0, 5.5, h.z - 25.0 + drift * 0.3);
        desiredLook.set(h.x - 20.0, 11.0, h.z + 30.0);
        break;
      }

      case 'port': {
        // Over the Marina's water at Veles e Vents' stacked white decks
        const drift = Math.sin(elapsed * 0.15) * 30.0;
        const v = SITE.veles;
        desiredPos.set(v.x + 220.0 + drift, 30.0, v.z + 200.0);
        desiredLook.set(v.x, 14.0, v.z);
        break;
      }

      case 'beach': {
                const drift = Math.sin(elapsed * 0.12) * 60.0;
        // on the sand by the water's edge, looking south along the shore (reference/v10-malvarrosa-7)
        const b = SITE.malvarrosa;
        desiredPos.set(b.x + 50.0, 4.5, b.z + drift * 0.1);
        desiredLook.set(b.x + 50.0 - 0.41 * 300.0 + 110.0, 0.5, b.z + 0.91 * 300.0);
        break;
      }

      case 'fixed': {
        // debugging & reference renders (main.js exposes it with ?debug): a still camera at fixedPos looking at fixedLook
        desiredPos.copy(this.fixedPos || desiredPos);
        desiredLook.copy(this.fixedLook || desiredLook);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        // circling over the old town & the Turia between the Micalet and the Ensanche
        const c = SITE.micalet;
        desiredPos.set(Math.cos(angle) * radius + c.x, alt, Math.sin(angle) * radius + c.z + 300.0);
        desiredLook.set(c.x, 40.0, c.z + 300.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
