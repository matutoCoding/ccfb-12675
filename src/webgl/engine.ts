// ============================================================
// 自定义 WebGL2 引擎：冯氏光照场景 + GPU 实例化粒子（shader 状态机）
// 粒子生命周期完全在 GPU 运行，CPU 只下发发射参数
// ============================================================
import type { Vec3 } from '../domain/types';
import { clamp, TAU } from '../lib/math';

// ---------------- 着色器 ----------------

const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vColor;
out vec3 vWorld;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vColor; in vec3 vWorld;
uniform vec3 uCamPos;
uniform vec3 uFlashPos;
uniform float uFlashIntensity;
uniform vec3 uFlashColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 ambient = vColor * 0.35;
  vec3 L = normalize(vec3(0.4, 0.8, 0.3));
  float diff = max(dot(N, L), 0.0);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 24.0) * 0.25;
  vec3 col = ambient + vColor * diff * 0.65 + vec3(spec);
  // 开爆动态点光源
  float fd = distance(uFlashPos, vWorld);
  float att = uFlashIntensity / (1.0 + 0.08*fd + 0.02*fd*fd);
  col += uFlashColor * att * max(dot(N, normalize(uFlashPos - vWorld + vec3(0.001))), 0.0);
  outColor = vec4(col, uAlpha);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=3) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() { vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec3 vColor; out vec4 o;
void main() { o = vec4(vColor, 1.0); }`;

// GPU 粒子：每实例一个粒子，uniform 传入爆心/时刻/颜色/初速度随机种子
const PARTICLE_VS = `#version 300 es
precision highp float;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uBurstTime;
uniform float uNow;
uniform vec3 uColor;
uniform float uSpeed;
uniform float uLife;
uniform float uSize;
uniform int uSeed;
out float vAge;
out vec3 vColor;
// 哈希随机
float hash(int n) { return fract(sin(float(n)*127.1 + float(uSeed)*311.7) * 43758.5453); }
void main() {
  int id = gl_VertexID;
  float r1 = hash(id);
  float r2 = hash(id + 997);
  float r3 = hash(id + 4777);
  // 球面均匀方向
  float theta = r1 * 6.2831853;
  float phi = acos(2.0 * r2 - 1.0);
  vec3 dir = vec3(sin(phi)*cos(theta), cos(phi), sin(phi)*sin(theta));
  float speed = uSpeed * (0.55 + 0.6 * r3);
  float age = max(uNow - uBurstTime, 0.0);
  vAge = age;
  // 状态机：0 上升抛体 → 1 重力衰减 → 2 余烬熄灭（全 GPU）
  vec3 vel = dir * speed;
  vec3 pos = uOrigin + vel * age + vec3(0.0, -0.5 * 9.81 * age * age, 0.0);
  float fade = clamp(1.0 - age / uLife, 0.0, 1.0);
  vColor = mix(uColor * 1.6, uColor * 0.35, age / uLife) * fade;
  gl_Position = uViewProj * vec4(pos, 1.0);
  gl_PointSize = uSize * fade * (300.0 / max(gl_Position.w, 1.0));
  if (age > uLife || gl_Position.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // 裁剪掉死亡粒子
}`;

const PARTICLE_FS = `#version 300 es
precision mediump float;
in float vAge; in vec3 vColor;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float glow = smoothstep(0.5, 0.0, r);
  o = vec4(vColor * glow, glow);
}`;

// ---------------- 相机 ----------------

export class OrbitCamera {
  target: Vec3 = [0, 0, 10];
  distance = 220;
  azimuth = -Math.PI / 2;
  elevation = 0.5;
  fov = 55 * Math.PI / 180;
  pos: Vec3 = [0, 0, 0];
  viewProj: Float32Array = new Float32Array(16);

  update(aspect: number) {
    const ce = Math.cos(this.elevation);
    this.pos = [
      this.target[0] + this.distance * ce * Math.cos(this.azimuth),
      this.target[1] + this.distance * ce * Math.sin(this.azimuth),
      this.target[2] + this.distance * Math.sin(this.elevation),
    ];
    const view = mat4LookAt(this.pos, this.target, [0, 0, 1]);
    const proj = mat4Perspective(this.fov, aspect, 0.5, 5000);
    this.viewProj = mat4Mul(proj, view) as Float32Array;
  }

  attach(canvas: HTMLCanvasElement) {
    let dragging = false;
    let lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.azimuth -= dx * 0.005;
      this.elevation = clamp(this.elevation + dy * 0.005, -0.2, 1.45);
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = clamp(this.distance * (1 + e.deltaY * 0.001), 15, 1500);
    }, { passive: false });
  }

  flyTo(pos: Vec3, target: Vec3, t: number) {
    // 简单线性插值（巡航路径由关键帧驱动）
    this.pos = [
      this.pos[0] + (pos[0] - this.pos[0]) * t,
      this.pos[1] + (pos[1] - this.pos[1]) * t,
      this.pos[2] + (pos[2] - this.pos[2]) * t,
    ];
    this.target = [
      this.target[0] + (target[0] - this.target[0]) * t,
      this.target[1] + (target[1] - this.target[1]) * t,
      this.target[2] + (target[2] - this.target[2]) * t,
    ];
  }
}

// ---------------- 场景对象 ----------------

export interface MeshObject {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
  mode: number;
  alpha: number;
}

export interface LineObject {
  vao: WebGLVertexArrayObject;
  vertexCount: number;
}

interface ActiveBurst {
  origin: Vec3;
  color: Vec3;
  startTime: number;
  life: number;
  speed: number;
  particleCount: number;
  size: number;
  flash: number;
}

// ---------------- 引擎 ----------------

export class GLEngine {
  gl: WebGL2RenderingContext;
  private sceneProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private particleProg: WebGLProgram;
  private meshes: MeshObject[] = [];
  private lines: LineObject[] = [];
  private bursts: ActiveBurst[] = [];
  private startTime = performance.now();
  private now = 0;
  drawCalls = 0;
  particleCount = 0;
  vramMB = 0;
  qualityScale = 1;
  private flashPos: Vec3 = [0, 0, -999];
  private flashIntensity = 0;
  private flashColor: Vec3 = [1, 0.9, 0.7];
  private ext: { loseCtx?: WEBGL_lose_context };
  onFps?: (fps: number) => void;
  private frames = 0;
  private fpsT = 0;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2，请使用最新版 Chrome/Edge');
    this.gl = gl;
    this.sceneProg = createProgram(gl, SCENE_VS, SCENE_FS);
    this.lineProg = createProgram(gl, LINE_VS, LINE_FS);
    this.particleProg = createProgram(gl, PARTICLE_VS, PARTICLE_FS);
    this.ext = { loseCtx: gl.getExtension('WEBGL_lose_context') ?? undefined };
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.autoQuality();
  }

  private autoQuality() {
    const dbg = this.gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(this.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const cores = navigator.hardwareConcurrency ?? 4;
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
    if (/swiftshader|llvmpipe/i.test(renderer) || cores <= 2 || mem <= 2) this.qualityScale = 0.35;
    else if (cores <= 4 || mem <= 4) this.qualityScale = 0.6;
  }

  clear() {
    const gl = this.gl;
    this.meshes.forEach((m) => gl.deleteVertexArray(m.vao));
    this.lines.forEach((l) => gl.deleteVertexArray(l.vao));
    this.meshes = [];
    this.lines = [];
    this.bursts = [];
  }

  addMesh(data: { pos: Float32Array; normal: Float32Array; color: Float32Array; mode?: number; alpha?: number }): MeshObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.setAttribute(0, data.pos, 3);
    this.setAttribute(1, data.normal, 3);
    this.setAttribute(2, data.color, 3);
    const obj: MeshObject = {
      vao, vertexCount: data.pos.length / 3,
      mode: data.mode ?? gl.TRIANGLES, alpha: data.alpha ?? 1,
    };
    this.meshes.push(obj);
    this.vramMB += (data.pos.byteLength + data.normal.byteLength + data.color.byteLength) / 1048576;
    return obj;
  }

  addLine(pos: Float32Array, color: Float32Array): LineObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.setAttribute(0, pos, 3);
    this.setAttribute(3, color, 3);
    const obj = { vao, vertexCount: pos.length / 3 };
    this.lines.push(obj);
    this.vramMB += (pos.byteLength + color.byteLength) / 1048576;
    return obj;
  }

  private setAttribute(loc: number, data: Float32Array, size: number) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  /** CPU 只下发一次开爆参数，粒子生命周期全部在 shader 内运行 */
  spawnBurst(o: { origin: Vec3; color: Vec3; life?: number; speed?: number; particles?: number; size?: number }) {
    const base = o.particles ?? 6000;
    this.bursts.push({
      origin: o.origin,
      color: o.color,
      startTime: this.now,
      life: o.life ?? 2.6,
      speed: o.speed ?? 22,
      particleCount: Math.floor(base * this.qualityScale),
      size: o.size ?? 5,
      flash: 1,
    });
    if (this.bursts.length > 40) this.bursts.shift();
    this.flashPos = o.origin;
    this.flashColor = o.color;
    this.flashIntensity = 180;
  }

  render(cam: OrbitCamera) {
    const gl = this.gl;
    const now = (performance.now() - this.startTime) / 1000;
    this.now = now;
    this.drawCalls = 0;
    this.particleCount = 0;

    if (this.canvas.width !== this.canvas.clientWidth || this.canvas.height !== this.canvas.clientHeight) {
      const dpr = Math.min(window.devicePixelRatio, 2);
      this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
      this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.04, 0.05, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    cam.update(this.canvas.width / Math.max(this.canvas.height, 1));

    // 场景网格
    gl.useProgram(this.sceneProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.sceneProg, 'uViewProj'), false, cam.viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'uCamPos'), cam.pos);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'uFlashPos'), this.flashPos);
    gl.uniform3fv(gl.getUniformLocation(this.sceneProg, 'uFlashColor'), this.flashColor);
    gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'uFlashIntensity'), this.flashIntensity);
    for (const m of this.meshes) {
      gl.bindVertexArray(m.vao);
      gl.uniform1f(gl.getUniformLocation(this.sceneProg, 'uAlpha'), m.alpha);
      if (m.alpha < 1) {
        gl.enable(gl.BLEND);
        gl.depthMask(false);
      }
      gl.drawArrays(m.mode, 0, m.vertexCount);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      this.drawCalls++;
    }

    // 线框
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, cam.viewProj);
    for (const l of this.lines) {
      gl.bindVertexArray(l.vao);
      gl.drawArrays(gl.LINES, 0, l.vertexCount);
      this.drawCalls++;
    }

    // GPU 粒子（加法混合发光）
    gl.useProgram(this.particleProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.particleProg, 'uViewProj'), false, cam.viewProj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    this.bursts = this.bursts.filter((b) => now - b.startTime < b.life + 0.5);
    for (const b of this.bursts) {
      gl.uniform3fv(gl.getUniformLocation(this.particleProg, 'uOrigin'), b.origin);
      gl.uniform1f(gl.getUniformLocation(this.particleProg, 'uBurstTime'), b.startTime);
      gl.uniform1f(gl.getUniformLocation(this.particleProg, 'uNow'), now);
      gl.uniform3fv(gl.getUniformLocation(this.particleProg, 'uColor'), b.color);
      gl.uniform1f(gl.getUniformLocation(this.particleProg, 'uSpeed'), b.speed);
      gl.uniform1f(gl.getUniformLocation(this.particleProg, 'uLife'), b.life);
      gl.uniform1f(gl.getUniformLocation(this.particleProg, 'uSize'), b.size);
      gl.uniform1i(gl.getUniformLocation(this.particleProg, 'uSeed'), Math.floor(b.startTime * 1000) % 100000);
      gl.drawArrays(gl.POINTS, 0, b.particleCount);
      this.particleCount += b.particleCount;
      this.drawCalls++;
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    this.flashIntensity *= 0.82;
    if (this.flashIntensity < 1) this.flashIntensity = 0;

    // FPS 统计
    this.frames++;
    if (now - this.fpsT >= 1) {
      this.onFps?.(this.frames / (now - this.fpsT));
      this.frames = 0;
      this.fpsT = now;
    }
  }

  /** 外部时间轴驱动：在指定仿真时刻补放开爆（回放模式） */
  replayBurst(origin: Vec3, color: Vec3, simTime: number, speed = 22) {
    const b: ActiveBurst = {
      origin, color, startTime: this.now, life: 2.6, speed,
      particleCount: Math.floor(6000 * this.qualityScale), size: 5, flash: 1,
    };
    this.bursts.push(b);
    this.flashPos = origin;
    this.flashColor = color;
    this.flashIntensity = 180;
    void simTime;
  }
}

// ---------------- 着色器工具 ----------------

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

// ---------------- 矩阵（列主序 Float32Array） ----------------

export function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

export function mat4LookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

export function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export { TAU };
