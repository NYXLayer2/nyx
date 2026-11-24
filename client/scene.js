// The sky. A fragment shader draws the star, its corona, the moon that crosses it and the stars behind;
// a 2D layer on top draws the ring of blocks and the line they are sealed into.
(() => {
  const C = window.BRAND.scene;
  const FRAG = `precision highp float;
uniform vec2 uRes, uCenter, uPath; uniform float uTime, uCover, uDim, uR, uRays, uMode, uMoon; uniform vec3 uA, uB, uHot;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a*noise(p); p = p*2.03 + 11.; a *= .5; } return v; }
void main(){
  vec2 p = (gl_FragCoord.xy - uCenter) / uR; float r = length(p), ang = atan(p.y, p.x); vec2 dir = p / max(r, 1e-4);
  // stars come out as the light goes
  vec2 g = gl_FragCoord.xy / uRes.y * 190.; vec2 id = floor(g); float h = hash(id);
  float star = step(.982, h) * smoothstep(.45, 0., length(fract(g) - .5 - (vec2(hash(id+1.), hash(id+2.)) - .5) * .7) * 2.6) * (.55 + .45*sin(uTime*(.6+h*2.5) + h*40.));
  vec3 col = vec3(star) * (.25 + .75*uCover) * mix(vec3(1.), mix(uA, uB, hash(id+7.)), .35);
  // the moon slides in from the upper right
  vec2 mo = uPath * (1. - uCover); float md = length(p - mo) / uMoon, moon = smoothstep(1.035, 1.015, md);
  // corona: slow streamers plus fine rays, sampled on the direction so it has no seam
  float n1 = fbm(dir*2.6 + vec2(0., uTime*.025) + r*.32), n2 = fbm(dir*8.5 - vec2(uTime*.04, 0.) + r*.12), n3 = fbm(dir*22. + r*.05 + uTime*.01);
  float stream = pow(n1, 1.7)*1.9, rays = (pow(n2, 3.)*2.4 + pow(n3, 4.)*1.6) * uRays;
  float fall = 1. / pow(max(r, 1.), mix(2.5, 1.9, uMode));
  float cor = (.42 + stream + rays) * fall;
  float tint = clamp(.5 + .5*sin(ang + n1*3.2 + uTime*.04), 0., 1.);
  vec3 ccol = mix(uA, uB, tint);
  col += ccol * cor * (.22 + .78*uCover) * 1.25;
  col += uHot * exp(-(max(r, 1.) - 1.) * 5.5) * 1.5 * uCover;
  float annulus = step(uMoon, .999) * smoothstep(1.02, .985, r) * uCover;                // a smaller moon leaves a ring of fire
  col += mix(uHot, ccol, .35) * annulus * 5.;                       // the white-hot limb at totality
  float open = 1. - uCover;                                                           // how much of the star still shows
  col += mix(uHot, ccol, clamp((r - 1.) * .22, 0., .8)) * open * (1.9 / pow(max(r, .6), 2.25)) * (.7 + .3*n1);               // daylight glare
  col += uHot * smoothstep(1.02, .96, r) * 6. * step(.002, open) * (1. - annulus);                      // the disc itself
  vec2 bead = normalize(uPath); float diamond = smoothstep(.72, .93, uCover) * smoothstep(1., .955, uCover) * step(.999, uMoon);
  col += uHot * diamond * (exp(-length(p - bead) * 9.) * 9. + exp(-length(p - bead) * 2.2) * 1.4);
  // the moon is the darkest thing on the page
  col = mix(col, vec3(0.), moon);
  col += ccol * smoothstep(1.0, .93, md) * smoothstep(.80, 1.0, md) * .05 * uCover;  // a breath of light on its edge
  col = 1. - exp(-col * 1.25);
  vec2 q = gl_FragCoord.xy / uRes; col *= mix(1., smoothstep(1.25, .25, length(q - .5)), .55);
  col *= 1. - uDim; col += (hash(gl_FragCoord.xy + uTime) - .5) * .018;
  gl_FragColor = vec4(col, 1.);
}`;
  const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v)), smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const rgb = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

  function start({ gl: cv, fx, target, mode = 0 }) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches, gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    const ctx = fx ? fx.getContext('2d') : null, cur = { ...target(0) }, N = 56, seg = new Array(N).fill(0).map(() => ({ lit: 0, sealed: 0 }));
    let prog, U = {}, w = 0, h = 0, dpr = 1, spin = 0, spinTo = 0, pulse = 0, t0 = performance.now(), running = true, head = 0, last = performance.now();
    if (gl) {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }')); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog); gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uRes', 'uCenter', 'uTime', 'uCover', 'uDim', 'uR', 'uRays', 'uMode', 'uA', 'uB', 'uHot', 'uMoon', 'uPath']) U[n] = gl.getUniformLocation(prog, n);
      gl.uniform1f(U.uMoon, C.moon || 1); gl.uniform2fv(U.uPath, C.path || [3.7, 1.45]);
      gl.uniform3fv(U.uA, C.a); gl.uniform3fv(U.uB, C.b); gl.uniform3fv(U.uHot, C.hot); gl.uniform1f(U.uRays, C.rays); gl.uniform1f(U.uMode, mode);
    } else cv.style.background = 'radial-gradient(circle at 50% 45%, #2a1846, #050308 60%)';
    function size() { dpr = Math.min(devicePixelRatio || 1, 1.5); w = cv.clientWidth; h = cv.clientHeight; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); if (gl) gl.viewport(0, 0, cv.width, cv.height); if (fx) { fx.width = cv.width; fx.height = cv.height; } }
    size(); addEventListener('resize', size);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(frame); });

    function ring(t, dtRing) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const R = cur.R, cx = cur.cx, cy = cur.cy, rx = R * 2.35, ry = R * 0.5, tilt = -0.12, ct = Math.cos(tilt), st = Math.sin(tilt);
      if (cur.ring > 0.002) {
        spin = lerp(spin, spinTo, 1 - Math.exp(-dtRing / 220));
        for (let pass = 0; pass < 2; pass++) for (let i = 0; i < N; i++) {
          const th = ((i + spin) / N) * Math.PI * 2, back = Math.sin(th) < 0; if ((pass === 0) !== back) continue;
          const order = ((i % N) + N) % N / N; if (order > cur.ring) continue;
          const ex = Math.cos(th) * rx, ey = Math.sin(th) * ry, x = cx + ex * ct - ey * st, y = cy + ex * st + ey * ct;
          if (back && Math.hypot(x - cx, y - cy) < R * 1.04 * (C.moon || 1)) continue;                 // the far side passes behind the moon
          const tx = -Math.sin(th) * rx, ty = Math.cos(th) * ry, rot = Math.atan2(tx * st + ty * ct, tx * ct - ty * st), depth = 0.55 + 0.45 * (Math.sin(th) * 0.5 + 0.5), s = seg[i];
          s.lit *= Math.exp(-dtRing / 900); const len = (2 * Math.PI * rx / N) * 0.62 * (0.35 + 0.65 * Math.abs(Math.sin(th)) + 0.3 * Math.abs(Math.cos(th))) , tall = R * 0.085 * depth;
          ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
          const colr = s.sealed ? C.sealed : C.ring, a = (back ? 0.32 : 0.8) * (0.45 + 0.55 * depth);
          ctx.fillStyle = rgb(colr, a * 0.16 + s.lit * 0.5); ctx.strokeStyle = rgb(colr, a * 0.75 + s.lit * 0.25); ctx.lineWidth = 1;
          if (s.lit > 0.03) { ctx.shadowColor = rgb(colr, 0.9); ctx.shadowBlur = 18 * s.lit; }
          ctx.beginPath(); ctx.rect(-len / 2, -tall / 2, len, tall); ctx.fill(); ctx.stroke(); ctx.restore();
        }
      }
      if (cur.seal > 0.002) {
        const hy = Math.min(h * 0.9, cy + R * 2.75), by = cy + ry * ct + 6, a = cur.seal, span = Math.min(w * 0.46, R * 3.1);
        const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, rgb(C.sealed, 0)); g.addColorStop(0.5, rgb(C.sealed, 0.9 * a)); g.addColorStop(1, rgb(C.sealed, 0));
        ctx.strokeStyle = g; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cx - span * a, hy); ctx.lineTo(cx + span * a, hy); ctx.stroke();
        const bg = ctx.createLinearGradient(0, by, 0, hy); bg.addColorStop(0, rgb(C.sealed, 0)); bg.addColorStop(1, rgb(C.sealed, 0.55 * a));
        ctx.strokeStyle = bg; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, by); ctx.lineTo(cx, by + (hy - by) * a); ctx.stroke();
        pulse *= Math.exp(-dtRing / 700); const drop = (t * 0.00035) % 1;                                     // receipts falling into the line
        for (let k = 0; k < 3; k++) { const d = (drop + k / 3) % 1, y = by + (hy - by) * d; ctx.fillStyle = rgb(C.sealed, a * (1 - d) * 0.9); ctx.fillRect(cx - 1.5, y, 3, 9); }
        ctx.fillStyle = rgb(C.sealed, a * (0.5 + pulse)); ctx.shadowColor = rgb(C.sealed, 1); ctx.shadowBlur = 16 + 30 * pulse; ctx.beginPath(); ctx.arc(cx, hy, 3 + 3 * pulse, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        for (let k = 1; k <= 14; k++) { const off = ((k * 46 + t * 0.012) % span); for (const sgn of [-1, 1]) { ctx.fillStyle = rgb(C.sealed, a * 0.5 * (1 - off / span)); ctx.fillRect(cx + sgn * off, hy - 4, 1, 8); } }
      }
    }
    function frame(now) {
      if (!running) return; const t = now - t0, dt = Math.min(1000, now - last), goal = target(t), k = still ? 1 : 1 - Math.exp(-dt / 170); last = now;
      for (const key in goal) cur[key] = lerp(cur[key] ?? goal[key], goal[key], k);
      if (gl) { gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform2f(U.uCenter, cur.cx * dpr, (h - cur.cy) * dpr); gl.uniform1f(U.uTime, still ? 40 : t / 1000); gl.uniform1f(U.uCover, cur.cover); gl.uniform1f(U.uDim, cur.dim); gl.uniform1f(U.uR, cur.R * dpr); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      if (ctx) ring(t, dt);
      if (!still) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame); if (still) addEventListener('scroll', () => requestAnimationFrame(frame), { passive: true });
    return {
      block() { head = (head + N - 1) % N; spinTo += 1; const i = ((-Math.round(spinTo)) % N + N) % N; seg[i].lit = 1; seg[i].sealed = 0; },
      sealed() { pulse = 1; for (const s of seg) s.sealed = 1; },
    };
  }
  window.L2Scene = { start, smooth, clamp, lerp };
})();
