// A small WebGL viewer for Minecraft skins: the player model as textured boxes. It turns only when the player drags it (or presses "Drehen"), never by itself,
// and it draws only when something changed, so it costs nothing while it stands still.
(function () {
  const BOXES = (slim) => {
    const aw = slim ? 3 : 4;   // [w,h,d], texture origin, x, y, z of the box's lower back-left corner (feet at y = 0), grow, mirror for old 64x32 skins
    return [
      { n: "head", s: [8, 8, 8], uv: [0, 0], p: [-4, 24, -4], g: 0 }, { n: "hat", s: [8, 8, 8], uv: [32, 0], p: [-4, 24, -4], g: 0.5, over: true },
      { n: "body", s: [8, 12, 4], uv: [16, 16], p: [-4, 12, -2], g: 0 }, { n: "jacket", s: [8, 12, 4], uv: [16, 32], p: [-4, 12, -2], g: 0.25, over: true },
      { n: "rarm", s: [aw, 12, 4], uv: [40, 16], p: [-4 - aw, 12, -2], g: 0 }, { n: "rsleeve", s: [aw, 12, 4], uv: [40, 32], p: [-4 - aw, 12, -2], g: 0.25, over: true },
      { n: "larm", s: [aw, 12, 4], uv: [32, 48], p: [4, 12, -2], g: 0, legacyFrom: [40, 16] }, { n: "lsleeve", s: [aw, 12, 4], uv: [48, 48], p: [4, 12, -2], g: 0.25, over: true },
      { n: "rleg", s: [4, 12, 4], uv: [0, 16], p: [-4, 0, -2], g: 0 }, { n: "rpants", s: [4, 12, 4], uv: [0, 32], p: [-4, 0, -2], g: 0.25, over: true },
      { n: "lleg", s: [4, 12, 4], uv: [16, 48], p: [0, 0, -2], g: 0, legacyFrom: [0, 16] }, { n: "lpants", s: [4, 12, 4], uv: [0, 48], p: [0, 0, -2], g: 0.25, over: true },
    ];
  };
  const m4 = {
    mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
    persp(f, asp, n, fa) { const t = 1 / Math.tan(f / 2), o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (fa + n) / (n - fa); o[11] = -1; o[14] = 2 * fa * n / (n - fa); return o; },
    tr(x, y, z) { const o = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); return o; },
    ry(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
    rx(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
  };
  const VS = "attribute vec3 p;attribute vec2 t;attribute float l;uniform mat4 m;varying vec2 v;varying float s;void main(){gl_Position=m*vec4(p,1.);v=t;s=l;}";
  const FS = "precision mediump float;varying vec2 v;varying float s;uniform sampler2D k;void main(){vec4 c=texture2D(k,v);if(c.a<.5)discard;gl_FragColor=vec4(c.rgb*s,1.);}";

  const VS2 = "attribute vec3 p;attribute vec2 t;attribute vec4 c;uniform mat4 m;varying vec2 v;varying vec4 k;void main(){gl_Position=m*vec4(p,1.);v=t;k=c;}";
  const FS2 = "precision mediump float;varying vec2 v;varying vec4 k;uniform sampler2D s;uniform float tx;void main(){vec4 b=tx>.5?texture2D(s,v):vec4(1.);vec4 o=b*k;if(o.a<.02)discard;gl_FragColor=o;}";

  class SkinView {
    constructor(canvas) {
      this.cv = canvas; this.yaw = -0.5; this.pitch = 0.08; this.target = null; this.dirty = false; this.ok = false; this.slim = false;
      const gl = this.gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
      if (!gl) return;
      const sh = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      const pr = this.pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return;
      gl.useProgram(pr); this.loc = { p: gl.getAttribLocation(pr, "p"), t: gl.getAttribLocation(pr, "t"), l: gl.getAttribLocation(pr, "l"), m: gl.getUniformLocation(pr, "m") };
      this.buf = gl.createBuffer(); this.tex = gl.createTexture(); this.ok = true; this.cos = []; this.dist = 78; this.ext = { x: 0, top: 32, bottom: 0 };
      const sh2 = (t, src) => { const x = gl.createShader(t); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      const p2 = this.pr2 = gl.createProgram(); gl.attachShader(p2, sh2(gl.VERTEX_SHADER, VS2)); gl.attachShader(p2, sh2(gl.FRAGMENT_SHADER, FS2)); gl.linkProgram(p2);
      this.loc2 = { p: gl.getAttribLocation(p2, "p"), t: gl.getAttribLocation(p2, "t"), c: gl.getAttribLocation(p2, "c"), m: gl.getUniformLocation(p2, "m"), s: gl.getUniformLocation(p2, "s"), tx: gl.getUniformLocation(p2, "tx") };
      let down = null;
      canvas.style.cursor = "grab"; canvas.style.touchAction = "none";
      canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; this.target = null; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; });
      canvas.addEventListener("pointermove", (e) => { if (!down) return; this.yaw += (e.clientX - down.x) * 0.012; this.pitch = Math.max(-0.45, Math.min(0.45, this.pitch + (e.clientY - down.y) * 0.006)); down = { x: e.clientX, y: e.clientY }; this.draw(); });
      const up = () => { down = null; canvas.style.cursor = "grab"; };
      canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
      new ResizeObserver(() => this.draw()).observe(canvas);
    }

    /** the equipped cape: its picture (40x64 back panel) as a flat piece of cloth behind the player; null removes it */
    setCape(src) {
      if (!this.ok) return Promise.resolve(false);
      if (!src) { this.capeOn = false; this.draw(); return Promise.resolve(true); }
      return new Promise((res) => {
        const img = new Image(); img.onload = () => {
          const gl = this.gl; if (!this.capeTex) { this.capeTex = gl.createTexture(); this.capeBuf = gl.createBuffer(); }
          gl.bindTexture(gl.TEXTURE_2D, this.capeTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          // the cloth hangs from the shoulders (y 24) down to y 8, a little away from the back (z -2), the lower end swinging out
          // a cloth with real thickness: outer face, inner face (towards the body, darker) and four walls whose picture is the edge of the cape
          const T = 0.9, A = [5, 24, -2.2], B = [-5, 24, -2.2], C = [-5, 8, -3.4], D = [5, 8, -3.4], o = [];
          const quad = (p, uv, l) => { for (const k of [0, 1, 2, 0, 2, 3]) o.push(p[k][0], p[k][1], p[k][2], uv[k][0], uv[k][1], l); };
          const back = (P) => [P[0], P[1], P[2] + T];
          quad([A, B, C, D], [[0, 0], [1, 0], [1, 1], [0, 1]], 0.95);
          quad([back(A), back(D), back(C), back(B)], [[0, 0], [0, 1], [1, 1], [1, 0]], 0.55);
          quad([A, back(A), back(D), D], [[0, 0], [0, 0], [0, 1], [0, 1]], 0.7);   // left edge (x = +5)
          quad([B, C, back(C), back(B)], [[1, 0], [1, 1], [1, 1], [1, 0]], 0.7);   // right edge
          quad([A, B, back(B), back(A)], [[0, 0], [1, 0], [1, 0], [0, 0]], 0.8);   // top
          quad([D, back(D), back(C), C], [[0, 1], [0, 1], [1, 1], [1, 1]], 0.6);   // hem
          gl.bindBuffer(gl.ARRAY_BUFFER, this.capeBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(o), gl.STATIC_DRAW); this.capeOn = true; this.draw(); res(true);
        }; img.onerror = () => res(false); img.src = src;
      });
    }

    /** vertex data of one mesh: model space of the game (blocks, y down, origin at the neck) -> pixels, y up, feet at 0, front towards +z */
    _geom(sd, variant, px, py) {
      const col = sd.c[Math.min(variant || 0, sd.c.length - 1)], op = [], tr = []; let ex = 0, top = -1e9, bottom = 1e9;
      for (let q = 0; q < sd.n; q++) {
        const vs = []; let solid = true;
        for (let k = 0; k < 4; k++) {
          const x = (sd.p[q * 12 + k * 3] + px) * 16, y = 24 - (sd.p[q * 12 + k * 3 + 1] + py) * 16, z = -sd.p[q * 12 + k * 3 + 2] * 16, c = col[q * 4 + k] >>> 0, a = (c >>> 24) / 255;
          if (a < 0.5) solid = false; ex = Math.max(ex, Math.abs(x)); top = Math.max(top, y); bottom = Math.min(bottom, y);
          vs.push([x, y, z, sd.u ? sd.u[q * 8 + k * 2] : 0, sd.u ? sd.u[q * 8 + k * 2 + 1] : 0, ((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, a]);
        }
        const dst = solid ? op : tr; for (const i of [0, 1, 2, 0, 2, 3]) dst.push(...vs[i]);
      }
      return { op: new Float32Array(op), tr: new Float32Array(tr), ex, top, bottom };
    }

    _upload(part, g) {
      const gl = this.gl; part.nop = g.op.length / 9; part.ntr = g.tr.length / 9;
      gl.bindBuffer(gl.ARRAY_BUFFER, part.bo); gl.bufferData(gl.ARRAY_BUFFER, g.op, gl.DYNAMIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, part.bt); gl.bufferData(gl.ARRAY_BUFFER, g.tr, gl.DYNAMIC_DRAW);
      const e = this.ext; this.ext = { x: Math.max(e.x, g.ex), top: Math.max(e.top, g.top), bottom: Math.min(e.bottom, g.bottom) };   // the camera only ever backs off, so it does not breathe with the wings
    }

    /**
     * Wings, halos, hats, back items, pets and boots: list = [{id, variant}], load(id) -> {json, png} (a still of the game's art, see tools/MeshDump.java).
     * With frames(list, seconds) -> [json | null] the meshes are then asked for live: the same art code as in the game (tools/MeshServer.java) runs the animation.
     */
    async setCosmetics(list, load, frames) {
      if (!this.ok) return; const gl = this.gl, parts = []; this.live = false; this.liveId = (this.liveId || 0) + 1; const my = this.liveId; this.ext = this.solo ? { x: 0, top: -1e9, bottom: 1e9 } : { x: 0, top: 32, bottom: 0 };
      for (let idx = 0; idx < list.length; idx++) {
        const it = list[idx]; let data; try { data = await load(it.id); } catch { continue; } if (!data || !data.json) continue;
        const m = JSON.parse(data.json), sides = m.s ? [["s", m.s, 0, 0]].concat(m.f ? [["f", m.f, 0, 0]] : []) : [["r", m.r, -1.9 / 16, 0.75], ["l", m.l, 1.9 / 16, 0.75]];
        for (const [key, sd, px, py] of sides) {
          const part = { ready: false, bo: gl.createBuffer(), bt: gl.createBuffer(), tex: null, nop: 0, ntr: 0, idx, key, px, py, variant: it.variant || 0 };
          this._upload(part, this._geom(sd, it.variant, px, py));
          if (sd.u && data.png) { part.tex = gl.createTexture(); const img = new Image(); img.onload = () => { gl.bindTexture(gl.TEXTURE_2D, part.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); part.ready = true; this.draw(); }; img.src = data.png; }
          parts.push(part);
        }
      }
      this.cos = parts; this.draw();
      if (frames && parts.length) this._live(list, frames, my);
    }

    /** the animated face of a shield or cape: the picture of this moment replaces the part's texture */
    _tex(p, url) {
      p.busy = true; const img = new Image(); img.onload = () => { const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); p.busy = false; this.draw(); }; img.onerror = () => { p.busy = false; }; img.src = url;
    }

    /** the live loop: about 25 times a second the game's art code is asked for the next picture of every worn cosmetic; it only runs while the viewer is on screen */
    async _live(list, frames, my) {
      this.live = true; let last = 0;
      while (this.live && this.liveId === my) {
        await new Promise((r) => setTimeout(r, Math.max(0, 40 - (performance.now() - last)))); last = performance.now();
        if (document.hidden || !this.cv.offsetParent) { await new Promise((r) => setTimeout(r, 400)); continue; }
        let res; try { res = await frames(list, performance.now() / 1000); } catch { res = null; }
        if (!res) { this.live = false; return; }   // no helper (no Java yet): the stills stay
        if (this.liveId !== my) return;
        for (let i = 0; i < list.length; i++) {
          let m; try { m = res[i] && JSON.parse(res[i]); } catch { m = null; } if (!m) continue;
          for (const p of this.cos) if (p.idx === i) { const sd = m[p.key]; if (sd) { if (p.key !== "f" || !m.tex) { sd.c = [sd.c[0]]; this._upload(p, this._geom(sd, 0, p.px, p.py)); } } if (p.key === "f" && m.tex && p.tex && !p.busy) this._tex(p, m.tex); }
        }
        this.draw();
      }
    }

    /**
     * Creatures (a Transform replaces the player, a pet stands beside): list = [{json, png, dx, dz, scale}]; hidePlayer draws only the creatures.
     * The models are the game's own (exported by LacGameTest.exportEntities): textured cubes, standing on the ground.
     */
    async setEntities(list, hidePlayer) {
      if (!this.ok) return; const gl = this.gl, parts = []; this.hidePlayer = !!hidePlayer; let ex = 0, top = 32, bottom = 0;
      for (const it of list) {
        const m = JSON.parse(it.json), sc = (it.scale || 1) * 16; let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
        for (let i = 0; i < m.n * 12; i += 3) { minX = Math.min(minX, m.p[i]); maxX = Math.max(maxX, m.p[i]); minY = Math.min(minY, m.p[i + 1]); maxY = Math.max(maxY, m.p[i + 1]); minZ = Math.min(minZ, m.p[i + 2]); maxZ = Math.max(maxZ, m.p[i + 2]); }
        const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, out = [];
        for (let q = 0; q < m.n; q++) { const vs = []; for (let k = 0; k < 4; k++) vs.push([(m.p[q * 12 + k * 3] - cx) * sc + (it.dx || 0), (maxY - m.p[q * 12 + k * 3 + 1]) * sc, -(m.p[q * 12 + k * 3 + 2] - cz) * sc + (it.dz || 0), m.u[q * 8 + k * 2], m.u[q * 8 + k * 2 + 1], 1, 1, 1, 1]); for (const i of [0, 1, 2, 0, 2, 3]) out.push(...vs[i]); }
        for (const v of out) { /* placeholder: extents below */ break; }
        const arr = new Float32Array(out); for (let i = 0; i < arr.length; i += 9) { ex = Math.max(ex, Math.abs(arr[i])); top = Math.max(top, arr[i + 1]); bottom = Math.min(bottom, arr[i + 1]); }
        const part = { bo: gl.createBuffer(), bt: gl.createBuffer(), tex: gl.createTexture(), nop: out.length / 9, ntr: 0 };
        gl.bindBuffer(gl.ARRAY_BUFFER, part.bo); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        const img = new Image(); img.onload = () => { gl.bindTexture(gl.TEXTURE_2D, part.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); this.draw(); }; img.src = it.png;
        parts.push(part);
      }
      this.ents = parts; this.entExt = { x: ex, top, bottom }; this.draw();
    }

    /** the skin as an image URL; slim = 3 pixel wide arms */
    setSkin(src, slim) {
      if (!this.ok) return Promise.resolve(false);
      return new Promise((res) => {
        const img = new Image(); img.onload = () => { this.legacy = img.height === 32; this.slim = !!slim; this.upload(img); this.build(); this.draw(); res(true); }; img.onerror = () => res(false); img.src = src;
      });
    }

    /** old 64x32 skins often have an opaque black "hat" area; the game makes it clear (Notch transparency hack), so do we */
    fixLegacy(img) {
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0);
      const d = x.getImageData(32, 0, 32, 16), a = d.data; let clear = false;
      for (let i = 3; i < a.length; i += 4) if (a[i] < 128) { clear = true; break; }
      if (!clear) { for (let i = 3; i < a.length; i += 4) a[i] = 0; x.putImageData(d, 32, 0); }
      return c;
    }

    upload(src) {
      const gl = this.gl, img = this.legacy ? this.fixLegacy(src) : src; gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); this.tw = 64; this.th = img.height;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    build() {
      const out = [], TW = this.tw, TH = this.th;
      for (const b of BOXES(this.slim)) {
        if (this.legacy && (b.over && b.n !== "hat")) continue;   // old skins have no body overlay layers
        const [w, h, d] = b.s, g = b.g; let [u, v] = b.uv, mirror = false;
        if (this.legacy && b.legacyFrom) { [u, v] = b.legacyFrom; mirror = true; }
        const x0 = b.p[0] - g, y0 = b.p[1] - g, z0 = b.p[2] - g, x1 = b.p[0] + w + g, y1 = b.p[1] + h + g, z1 = b.p[2] + d + g;
        // [face uv rect (u, v, w, h) on the texture, 4 corners (bottom-left, bottom-right, top-right, top-left as seen from outside), shade]
        const faces = [
          [[u + d, v + d, w, h], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0.88],      // front (+z)
          [[u + 2 * d + w, v + d, w, h], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], 0.8], // back
          [[u, v + d, d, h], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], 0.7],            // right of the character (-x)
          [[u + d + w, v + d, d, h], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], 0.7],    // left of the character (+x)
          [[u + d, v, w, d], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 1.0],            // top
          [[u + d + w, v, w, d], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], 0.55],       // bottom
        ];
        for (const [r, c, sh] of faces) {
          let [ru, rv, rw, rh] = r; const eps = 0.02;   // a hair inside the texel so neighbours do not bleed
          let ua = (ru + eps) / TW, ub = (ru + rw - eps) / TW, va = (rv + rh - eps) / TH, vb = (rv + eps) / TH;
          if (mirror) { const t = ua; ua = ub; ub = t; }
          const uvs = [[ua, va], [ub, va], [ub, vb], [ua, vb]];
          for (const i of [0, 1, 2, 0, 2, 3]) out.push(c[i][0], c[i][1], c[i][2], uvs[i][0], uvs[i][1], sh);
        }
      }
      this.count = out.length / 6; const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    }

    /** turn half way round (to the back or to the front) with a short ease; only on request */
    flip() {
      this.target = Math.round((this.yaw - 0.0) / Math.PI) * Math.PI + Math.PI + (Math.round(this.yaw / Math.PI) % 2 === 0 ? -0.5 : 0.5) * 0;
      const from = this.yaw, to = from + Math.PI, t0 = performance.now(), step = (now) => {
        const k = Math.min(1, (now - t0) / 520), e = 1 - Math.pow(1 - k, 3); this.yaw = from + (to - from) * e; this.draw(); if (k < 1 && this.target !== null) requestAnimationFrame(step);
      };
      this.target = to; requestAnimationFrame(step);
    }

    draw() {
      if (!this.ok || (!this.count && !this.solo) || this.dirty) return; this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; this._paint(); });
    }

    /** a picture of the model as it is now (transparent background): paints at once and reads the canvas in the same step */
    async snapshot(w, h) {
      if (!this.ok) return null;
      for (let i = 0; i < 40 && this.cos.some((p) => p.tex && !p.ready); i++) await new Promise((r) => setTimeout(r, 25));
      this.cv.style.width = w + "px"; this.cv.style.height = h + "px"; this._paint(); return this.cv.toDataURL("image/png");
    }

    _paint() {
      {
        const gl = this.gl, cv = this.cv, dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(2, Math.round(cv.clientWidth * dpr)), h = Math.max(2, Math.round(cv.clientHeight * dpr));
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
        const solo = !!this.solo, fov = 0.62, th = Math.tan(fov / 2), e0 = this.ext, en = this.ents && this.ents.length ? this.entExt : null, e = this.hidePlayer && en ? en : { x: Math.max(e0.x, en ? en.x : 0), top: Math.max(e0.top, en ? en.top : 0), bottom: Math.min(e0.bottom, en ? en.bottom : 0) };   // far enough that wings and halos fit the picture
        let mid = 16; let dist = Math.max(78, (Math.max(e.x, 11) * 1.25 + 6) / (th * (w / h)), (Math.max(e.top - 16, 16 - e.bottom) + 4) / th);
        if (solo) {   // only the cosmetic: centred on itself, as close as it fits
          const cs = this.cos && this.cos.length, ce = this.ents && this.ents.length ? this.entExt : null, top = Math.max(cs ? e0.top : -1e9, ce ? ce.top : -1e9), bot = Math.min(cs ? e0.bottom : 1e9, ce ? ce.bottom : 1e9), ex = Math.max(cs ? e0.x : 0, ce ? ce.x : 0, 2);
          if (top > bot) { mid = (top + bot) / 2; dist = Math.max(11, (ex * 1.75 + 4) / (th * (w / h)), ((top - bot) / 2 * 1.25 + 4) / th); }
        }
        const proj = m4.persp(fov, w / h, 10, 400), view = m4.mul(m4.tr(0, 0, -dist), m4.mul(m4.rx(this.pitch), m4.mul(m4.ry(this.yaw), m4.tr(0, -mid, 0))));
        const mvp = m4.mul(proj, view); gl.useProgram(this.pr); gl.uniformMatrix4fv(this.loc.m, false, mvp);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); const S = 24; const hide = this.hidePlayer || solo;
        gl.enableVertexAttribArray(this.loc.p); gl.vertexAttribPointer(this.loc.p, 3, gl.FLOAT, false, S, 0);
        gl.enableVertexAttribArray(this.loc.t); gl.vertexAttribPointer(this.loc.t, 2, gl.FLOAT, false, S, 12);
        gl.enableVertexAttribArray(this.loc.l); gl.vertexAttribPointer(this.loc.l, 1, gl.FLOAT, false, S, 20);
        if (!hide) gl.drawArrays(gl.TRIANGLES, 0, 0);
        if (!hide) { gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.drawArrays(gl.TRIANGLES, 0, this.count); }
        if (this.capeOn && !hide) {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.capeBuf);
          gl.vertexAttribPointer(this.loc.p, 3, gl.FLOAT, false, S, 0); gl.vertexAttribPointer(this.loc.t, 2, gl.FLOAT, false, S, 12); gl.vertexAttribPointer(this.loc.l, 1, gl.FLOAT, false, S, 20);
          gl.bindTexture(gl.TEXTURE_2D, this.capeTex); gl.drawArrays(gl.TRIANGLES, 0, 36);
        }
        const all = (this.hidePlayer ? [] : this.cos).concat(this.ents || []);
        if (all.length) {
          gl.useProgram(this.pr2); gl.uniformMatrix4fv(this.loc2.m, false, mvp); gl.uniform1i(this.loc2.s, 0); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
          const L = this.loc2, ST = 36;
          const bind = (buf) => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(L.p); gl.vertexAttribPointer(L.p, 3, gl.FLOAT, false, ST, 0); gl.enableVertexAttribArray(L.t); gl.vertexAttribPointer(L.t, 2, gl.FLOAT, false, ST, 12); gl.enableVertexAttribArray(L.c); gl.vertexAttribPointer(L.c, 4, gl.FLOAT, false, ST, 20); };
          for (const pass of [0, 1]) {   // solid parts write depth; see-through parts blend on top without writing it
            gl.depthMask(pass === 0);
            for (const p of all) { const n = pass === 0 ? p.nop : p.ntr; if (!n) continue; bind(pass === 0 ? p.bo : p.bt); gl.uniform1f(L.tx, p.tex ? 1 : 0); if (p.tex) gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.drawArrays(gl.TRIANGLES, 0, n); }
          }
          gl.depthMask(true); gl.disable(gl.BLEND);
        }
      }
    }
  }
  window.SkinView = SkinView;
})();
