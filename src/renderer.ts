import * as THREE from 'three';
import { createWorld, createCar } from './world';
import type { StaticCollider } from './collision';
import { sampleTrack, trackPosition, wrapDistance, TRACK_LENGTH } from './track';
import type { GameEvent, ItemType, Racer, RaceState } from './types';
import { DEFAULT_SKIN, SKINS, isSkinId, type SkinId } from './skins';
import { disposeCarVisual } from './car-skin';

const ITEM_COLORS: Record<ItemType, number> = {
  rocket: 0xf76d37, mine: 0xae80ef, shield: 0x5edacc, nitro: 0xf8cf5c,
};

type Particle = { p: THREE.Vector3; v: THREE.Vector3; life: number; total: number };

export class RaceRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.2, 1800);
  private world: ReturnType<typeof createWorld>;
  private cars = new Map<number, THREE.Group>();
  private selectedSkin: SkinId = DEFAULT_SKIN;
  private pickups = new Map<number, THREE.Group>();
  private projectiles = new Map<number, THREE.Group>();
  private sun: THREE.DirectionalLight;
  private lookAt = new THREE.Vector3();
  private lastPhase = '';
  private time = 0;
  private shake = 0;
  private resizeObserver: ResizeObserver;
  private particles: Particle[] = [];
  private particlePositions = new Float32Array(540 * 3);
  private particleColors = new Float32Array(540 * 3);
  private particleGeometry = new THREE.BufferGeometry();
  private particleTexture: THREE.CanvasTexture;
  private particleCursor = 0;
  private highQuality = true;
  private readonly tex = new Map<ItemType, THREE.CanvasTexture>();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();

  get staticColliders(): readonly StaticCollider[] { return this.world.colliders; }
  get playerSkin(): SkinId { return this.selectedSkin; }

  /** Switch only the locally owned player visual. Race state and rivals are untouched. */
  setPlayerSkin(id: SkinId): boolean {
    if (!isSkinId(id)) return false;
    if (id === this.selectedSkin) return true;
    for (const [racerId, previous] of this.cars) {
      if (!previous.userData.isPlayer) continue;
      const replacement = createCar(previous.userData.baseColor, true, SKINS[id]);
      replacement.position.copy(previous.position);
      replacement.rotation.copy(previous.rotation);
      replacement.scale.copy(previous.scale);
      replacement.visible = previous.visible;
      // Preserve articulated state so a switch cannot reset wheel spin or a live effect.
      for (const key of ['wheels', 'flames'] as const) {
        const oldParts: THREE.Object3D[] = previous.userData[key] ?? [];
        const newParts: THREE.Object3D[] = replacement.userData[key] ?? [];
        newParts.forEach((part, i) => {
          if (!oldParts[i]) return;
          part.rotation.copy(oldParts[i].rotation);
          part.scale.copy(oldParts[i].scale);
          part.visible = oldParts[i].visible;
        });
      }
      replacement.userData.shield.rotation.copy(previous.userData.shield.rotation);
      replacement.userData.shield.visible = previous.userData.shield.visible;
      (previous.parent ?? this.scene).add(replacement);
      this.cars.set(racerId, replacement);
      disposeCarVisual(previous);
    }
    this.selectedSkin = id;
    return true;
  }

  /** UI reticles follow the rendered camera; off-screen targets keep only their text hint. */
  projectRacer(racer: Racer): { x: number; y: number } | null {
    const point = trackPosition(racer.distance, racer.lateral, 1.4).project(this.camera);
    if (point.z < -1 || point.z > 1 || Math.abs(point.x) > 0.94 || Math.abs(point.y) > 0.88) return null;
    return { x: (point.x + 1) * this.container.clientWidth / 2,
      y: (1 - point.y) * this.container.clientHeight / 2 };
  }

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '赤沙狂飙三维峡谷赛道');
    this.container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0xd9c5a9);
    this.scene.fog = new THREE.Fog(0xd8b998, 210, 1050);
    const hemisphere = new THREE.HemisphereLight(0xc9e2e0, 0xc27c53, 2.6);
    this.scene.add(hemisphere);
    this.sun = new THREE.DirectionalLight(0xffecd0, 3.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -65, right: 65, top: 65, bottom: -65, near: 1, far: 250 });
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.06;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1450, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          topColor: { value: new THREE.Color(0x9abebd) },
          bottomColor: { value: new THREE.Color(0xf4dbc0) },
        },
        vertexShader: 'varying vec3 vWorld; void main(){vWorld=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'uniform vec3 topColor;uniform vec3 bottomColor;varying vec3 vWorld;void main(){float h=normalize(vWorld).y;vec3 c=mix(bottomColor,topColor,smoothstep(-0.03,0.65,h));gl_FragColor=vec4(c,1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
      }),
    );
    sky.renderOrder = -2;
    this.scene.add(sky);
    const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(48, 32, 16), new THREE.MeshBasicMaterial({ color: 0xfff0c9, fog: false }));
    sunDisc.position.set(-600, 340, -800);
    this.scene.add(sunDisc);
    this.world = createWorld(this.scene);
    for (let i = 0; i < 540; i++) {
      this.particles.push({ p: new THREE.Vector3(0, -1000, 0), v: new THREE.Vector3(), life: 0, total: 1 });
      this.particlePositions[i * 3 + 1] = -1000;
    }
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.particleGeometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3).setUsage(THREE.DynamicDrawUsage));
    const particleCanvas = document.createElement('canvas');
    particleCanvas.width = particleCanvas.height = 32;
    const particleContext = particleCanvas.getContext('2d')!;
    const glow = particleContext.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, 'rgba(255,255,255,1)');
    glow.addColorStop(0.25, 'rgba(255,255,255,.85)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    particleContext.fillStyle = glow;
    particleContext.fillRect(0, 0, 32, 32);
    this.particleTexture = new THREE.CanvasTexture(particleCanvas);
    const particles = new THREE.Points(this.particleGeometry, new THREE.PointsMaterial({
      size: 0.34, map: this.particleTexture, vertexColors: true, transparent: true, opacity: 0.8,
      depthWrite: false, sizeAttenuation: true,
    }));
    particles.frustumCulled = false;
    this.scene.add(particles);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  setQuality(high: boolean) {
    this.highQuality = high;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 1.6 : 1));
    this.renderer.shadowMap.enabled = high;
    this.resize();
  }

  private resize() {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private pickupTexture(type: ItemType): THREE.CanvasTexture {
    if (this.tex.has(type)) return this.tex.get(type)!;
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `#${ITEM_COLORS[type].toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#fff8df'; ctx.lineWidth = 5;
    ctx.strokeRect(9, 9, 110, 110);
    ctx.fillStyle = '#233332'; ctx.strokeStyle = '#233332'; ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (type === 'nitro') {
      ctx.beginPath(); ctx.moveTo(71, 24); ctx.lineTo(38, 69); ctx.lineTo(61, 69); ctx.lineTo(55, 104); ctx.lineTo(94, 54); ctx.lineTo(71, 54); ctx.closePath(); ctx.fill();
    } else if (type === 'shield') {
      ctx.beginPath(); ctx.moveTo(64, 26); ctx.lineTo(96, 38); ctx.lineTo(91, 75); ctx.quadraticCurveTo(84, 90, 64, 103); ctx.quadraticCurveTo(42, 90, 36, 75); ctx.lineTo(32, 38); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(64, 45); ctx.lineTo(64, 77); ctx.stroke();
    } else if (type === 'rocket') {
      ctx.save(); ctx.translate(64, 64); ctx.rotate(Math.PI / 4);
      ctx.beginPath(); ctx.moveTo(0, -41); ctx.quadraticCurveTo(27, -23, 17, 25); ctx.lineTo(-17, 25); ctx.quadraticCurveTo(-27, -23, 0, -41); ctx.fill();
      ctx.fillRect(-6, 32, 12, 16); ctx.fillRect(-28, 9, 13, 22); ctx.fillRect(15, 9, 13, 22);
      ctx.fillStyle = '#fff5d6'; ctx.beginPath(); ctx.arc(0, -7, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(64, 64, 22, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        ctx.beginPath(); ctx.moveTo(64 + Math.cos(a) * 23, 64 + Math.sin(a) * 23); ctx.lineTo(64 + Math.cos(a) * 39, 64 + Math.sin(a) * 39); ctx.stroke();
      }
      ctx.fillStyle = '#fff5d6'; ctx.beginPath(); ctx.arc(64, 64, 7, 0, Math.PI * 2); ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.tex.set(type, texture);
    return texture;
  }

  private createPickup(type: ItemType) {
    const group = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.55, 1.55, 1.55), new THREE.MeshStandardMaterial({
      map: this.pickupTexture(type), roughness: 0.4, metalness: 0.15,
      emissive: ITEM_COLORS[type], emissiveIntensity: 0.22,
    }));
    box.rotation.set(0.15, Math.PI / 4, 0.12);
    box.castShadow = true;
    group.add(box);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.055, 6, 32), new THREE.MeshBasicMaterial({ color: ITEM_COLORS[type] }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -1.65;
    group.add(ring);
    this.scene.add(group);
    return group;
  }

  private createProjectile(type: 'rocket' | 'mine') {
    const group = new THREE.Group();
    if (type === 'rocket') {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1.5, 8), new THREE.MeshStandardMaterial({ color: 0xf4ecd8, metalness: 0.45, roughness: 0.35 }));
      body.rotation.x = Math.PI / 2;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 8), new THREE.MeshStandardMaterial({ color: 0xf15c32 }));
      tip.rotation.x = Math.PI / 2; tip.position.z = 0.95;
      const fire = new THREE.Mesh(new THREE.ConeGeometry(0.25, 1.4, 8), new THREE.MeshBasicMaterial({ color: 0xffb84e }));
      fire.rotation.x = -Math.PI / 2; fire.position.z = -1.3;
      group.add(body, tip, fire);
    } else {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.35, 12), new THREE.MeshStandardMaterial({ color: 0x343942, metalness: 0.6, roughness: 0.4 }));
      const top = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.1, 8, 20), new THREE.MeshBasicMaterial({ color: 0xc98dfa }));
      top.rotation.x = Math.PI / 2; top.position.y = 0.2;
      group.add(base, top);
    }
    this.scene.add(group);
    return group;
  }

  private emit(position: THREE.Vector3, count: number, color: number, force = 3, life = 0.65) {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const index = this.particleCursor++ % this.particles.length;
      const p = this.particles[index];
      p.p.copy(position);
      p.v.set((Math.random() - 0.5) * force, Math.random() * force * 0.8, (Math.random() - 0.5) * force);
      p.life = p.total = life * (0.5 + Math.random() * 0.5);
      this.particleColors[index * 3] = c.r;
      this.particleColors[index * 3 + 1] = c.g;
      this.particleColors[index * 3 + 2] = c.b;
    }
  }

  event(event: GameEvent, state: RaceState) {
    const racer = state.racers.find(r => r.id === event.racer);
    if (!racer) return;
    const position = trackPosition(racer.distance, racer.lateral, 1);
    if (event.type === 'collision') {
      const contact = event.contact ? new THREE.Vector3(event.contact.x, event.contact.y, event.contact.z) : position;
      const strength = event.strength ?? 0.3;
      this.emit(contact, Math.round(10 + strength * 34), event.collisionKind === 'rock' ? 0xe6bb89 : 0xffd185, 3 + strength * 10, 0.45);
      if (racer.isPlayer && event.text !== 'PROJECTILE_BLOCKED') this.shake = Math.max(this.shake, strength * 0.38);
    }
    if (event.type === 'hit') {
      this.emit(position, 60, 0xff9d43, 15, 1.2);
      if (racer.isPlayer) this.shake = 0.65;
    }
    if (event.type === 'pickup') this.emit(position, 24, ITEM_COLORS[event.item ?? 'shield'], 7, 0.7);
    if (event.type === 'shield') this.emit(position, 28, 0x68f4ea, 9, 0.8);
    if (event.type === 'drift') this.emit(position, 20, 0x86f9df, 7, 0.7);
  }

  update(state: RaceState, dt: number) {
    const frozen = state.phase === 'paused';
    if (!frozen) this.time += dt;
    this.world.update(this.time);
    const menu = state.phase === 'menu';
    const player = state.racers[0];
    const pd = menu ? 22 : player.distance;
    const pl = menu ? 0 : player.lateral;
    const ps = sampleTrack(pd);
    const playerPosition = trackPosition(pd, pl);

    for (const racer of state.racers) {
      let car = this.cars.get(racer.id);
      if (!car) {
        car = createCar(racer.color, racer.isPlayer, racer.isPlayer ? SKINS[this.selectedSkin] : undefined);
        this.cars.set(racer.id, car); this.scene.add(car);
      }
      car.visible = !menu || racer.isPlayer;
      // Rivals between the chase camera and our bumper must not fill the screen.
      const relativeDistance = wrapDistance(racer.distance - player.distance + TRACK_LENGTH / 2) - TRACK_LENGTH / 2;
      if (!menu && !racer.isPlayer && relativeDistance < -6 && relativeDistance > -23) car.visible = false;
      if (!car.visible) continue;
      const distance = menu ? pd : racer.distance;
      const lateral = menu ? pl : racer.lateral;
      const p = sampleTrack(distance);
      car.position.set(p.x + p.nx * lateral, p.y + 0.04, p.z + p.nz * lateral);
      car.rotation.y = p.heading + (menu ? 0 : racer.heading);
      car.rotation.z = menu ? 0 : -Math.sin(racer.heading) * Math.min(racer.speed / 60, 1) * 0.13;
      const ahead = sampleTrack(distance + 2.5);
      const behind = sampleTrack(distance - 2.5);
      car.rotation.x = -Math.atan2(ahead.y - behind.y, 5);
      if (!menu && !frozen) car.position.y += Math.sin(this.time * 24) * Math.min(racer.speed / 800, 0.055);
      const wheels: THREE.Object3D[] = car.userData.wheels ?? [];
      if (!frozen) for (const wheel of wheels) wheel.rotation.x += (menu ? 0 : racer.speed) * dt / 0.55;
      const boosted = !menu && racer.boostTime > 0;
      const flames: THREE.Object3D[] = car.userData.flames ?? [];
      for (const flame of flames) {
        flame.visible = boosted;
        if (boosted) flame.scale.setScalar(0.8 + Math.random() * 0.4);
      }
      if (car.userData.shield) {
        car.userData.shield.visible = !menu && racer.shield > 0;
        car.userData.shield.rotation.y = this.time;
      }
      if (!menu && !frozen && racer.speed > 12 && (racer.driftTime > 0.15 || Math.abs(racer.lateral) > 9.5)) {
        const dust = trackPosition(distance - 2.3, lateral + (Math.random() - 0.5) * 2.2, 0.5);
        this.emit(dust, this.highQuality ? 3 : 1, racer.driftTime > 0.15 ? (racer.charge >= 0.99 ? 0x65efda : 0xffbe61) : 0xd8b392, 2.4, 0.7);
      }
      if (boosted && !frozen) this.emit(trackPosition(distance - 3, lateral, 0.75), 3,
        racer.isPlayer ? SKINS[this.selectedSkin].glow : 0x84f0f7, 1.5, 0.4);
    }

    for (const pickup of state.pickups) {
      let mesh = this.pickups.get(pickup.id);
      if (!mesh) { mesh = this.createPickup(pickup.type); this.pickups.set(pickup.id, mesh); }
      const p = sampleTrack(pickup.distance);
      mesh.position.set(p.x + p.nx * pickup.lateral, p.y + 1.9 + Math.sin(this.time * 2.4 + pickup.id) * 0.23, p.z + p.nz * pickup.lateral);
      mesh.children[0].rotation.y = this.time * 0.7 + pickup.id;
      mesh.visible = pickup.cooldown <= 0;
    }
    const ids = new Set(state.projectiles.map(p => p.id));
    for (const [id, mesh] of this.projectiles) if (!ids.has(id)) {
      this.scene.remove(mesh);
      mesh.traverse(obj => { if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); (obj.material as THREE.Material).dispose(); } });
      this.projectiles.delete(id);
    }
    for (const projectile of state.projectiles) {
      let mesh = this.projectiles.get(projectile.id);
      if (!mesh) { mesh = this.createProjectile(projectile.type); this.projectiles.set(projectile.id, mesh); }
      mesh.position.copy(trackPosition(projectile.distance, projectile.lateral, projectile.type === 'rocket' ? 1.2 : 0.24));
      mesh.rotation.y = sampleTrack(projectile.distance).heading;
      if (projectile.type === 'rocket' && !frozen) this.emit(mesh.position, 2, 0xffcd7b, 0.9, 0.5);
    }

    if (!frozen) {
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        p.life -= dt;
        if (p.life > 0) {
          p.p.addScaledVector(p.v, dt); p.v.y -= dt * 3.5;
          this.particlePositions[i * 3] = p.p.x;
          this.particlePositions[i * 3 + 1] = p.p.distanceToSquared(this.camera.position) < 6.25 ? -1000 : p.p.y;
          this.particlePositions[i * 3 + 2] = p.p.z;
        } else this.particlePositions[i * 3 + 1] = -1000;
      }
      this.particleGeometry.attributes.position.needsUpdate = true;
      this.particleGeometry.attributes.color.needsUpdate = true;
    }

    if (menu) {
      const mobile = this.camera.aspect < 0.9;
      const orbit = Math.sin(this.time * 0.10) * 0.55;
      this.targetPosition.set(playerPosition.x + ps.nx * (mobile ? 13 : -7.5) + ps.tx * (10.5 + orbit), playerPosition.y + (mobile ? 6.7 : 2.1), playerPosition.z + ps.nz * (mobile ? 13 : -7.5) + ps.tz * (10.5 + orbit));
      this.targetLook.set(playerPosition.x + ps.nx * (mobile ? 0 : 7.4), playerPosition.y + (mobile ? 3.5 : 1.2), playerPosition.z + ps.nz * (mobile ? 0 : 7.4));
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 53, 0.08);
    } else {
      const ahead = trackPosition(pd + 12, pl * 0.35, 1.3);
      const behind = trackPosition(pd - (player.boostTime > 0 ? 9.2 : 7.8), pl * 0.95, 4.6);
      this.targetPosition.copy(behind);
      this.targetLook.copy(ahead);
      const fov = 59 + Math.min(player.speed / 80, 1) * 7 + (player.boostTime > 0 ? 6 : 0);
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 1 - Math.exp(-dt * 5));
    }
    if (this.lastPhase === '') {
      this.camera.position.copy(this.targetPosition); this.lookAt.copy(this.targetLook);
    } else if (!frozen) {
      const lerp = 1 - Math.exp(-dt * (menu ? 3 : 18));
      this.camera.position.lerp(this.targetPosition, lerp);
      this.lookAt.lerp(this.targetLook, lerp);
    }
    this.lastPhase = state.phase;
    this.shake = Math.max(0, this.shake - dt * 1.3);
    if (this.shake > 0 && !frozen) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
    }
    this.camera.lookAt(this.lookAt);
    this.camera.updateProjectionMatrix();
    this.sun.position.copy(playerPosition).add(new THREE.Vector3(-45, 90, -30));
    this.sun.target.position.copy(playerPosition);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.cars.forEach(car => disposeCarVisual(car));
    this.cars.clear();
    this.world.dispose();
    this.scene.traverse(obj => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) mat.dispose();
      }
    });
    this.tex.forEach(t => t.dispose());
    this.particleTexture.dispose();
    this.sun.shadow.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
