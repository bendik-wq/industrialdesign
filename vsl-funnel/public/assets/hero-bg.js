/* Hero background: an ambient, slowly flowing "silk" of soft colour behind the
 * VSL (WebGL fragment shader, domain-warped noise with gentle sheen bands).
 * Rendered at reduced resolution — it's all soft gradients, so it stays crisp
 * and cheap. Pauses off-screen / in background tabs; one still frame for
 * reduced motion; a CSS gradient if WebGL isn't available. */
(function () {
  'use strict';
  var canvas = document.querySelector('[data-hero-canvas]');
  if (!canvas) return;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dark = document.documentElement.getAttribute('data-palette') === 'ink';
  var gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false, powerPreference: 'low-power' });
  if (!gl) { canvas.classList.add('hero-canvas-fallback'); return; }

  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FRAG = [
    'precision mediump float;',
    'uniform vec2 r;uniform float t;uniform vec3 c0,c1,c2,c3,c4;',
    // 2D simplex noise (Ashima / Stefan Gustavson, MIT)
    'vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}vec2 m289(vec2 x){return x-floor(x*(1./289.))*289.;}',
    'vec3 perm(vec3 x){return m289(((x*34.)+1.)*x);}',
    'float sn(vec2 v){const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);',
    'vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);',
    'vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=m289(i);vec3 p=perm(perm(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));',
    'vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);m=m*m;m=m*m;',
    'vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;',
    'm*=1.79284291400159-.85373472095314*(a0*a0+h*h);vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.*dot(m,g);}',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/r;vec2 q=uv;q.x*=r.x/r.y;',
    '  float s=t*.045;',
    // domain warp: two layers of slow noise bend the space so colours flow like silk
    '  vec2 w=vec2(sn(q*.85+vec2(s,-s*.7)),sn(q*.85+vec2(-s*.6,s)+5.2));',
    '  vec2 w2=vec2(sn(q*1.3+w*1.1+vec2(1.7,9.2)+s*.5),sn(q*1.3+w*1.1+vec2(8.3,2.8)-s*.4));',
    '  float n=sn(q*.7+w2*.9+s*.3);',
    '  vec3 col=mix(c0,c1,smoothstep(-.6,.6,w.x));',
    '  col=mix(col,c2,smoothstep(-.3,.8,w2.y)*.85);',
    '  col=mix(col,c3,smoothstep(.1,.9,n)*.7);',
    '  col=mix(col,c4,smoothstep(.35,1.,w2.x)*.55);',
    // soft sheen bands, like light catching folds of fabric
    '  float band=sin((q.x*1.6+q.y*.9+w2.x*1.4+n*.8)*3.2-t*.12);',
    '  col+=vec3(1.)*pow(max(band,0.),3.)*.06;',
    // gentle fade to the page colour at the top and bottom so it melts into the layout
    '  float v=smoothstep(0.,.22,uv.y)*smoothstep(1.,.62,uv.y);',
    '  col=mix(c0,col,v);',
    // tiny dither to avoid gradient banding
    '  col+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;',
    '  gl_FragColor=vec4(col,1.);',
    '}',
  ].join('\n');

  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.classList.add('hero-canvas-fallback'); return; }
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  var uR = gl.getUniformLocation(prog, 'r'), uT = gl.getUniformLocation(prog, 't');

  function hex(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }
  // page white → ice blue → periwinkle → lavender → warm peach (dark palette: deep navy tones)
  var PAL = dark ? ['#0b1220', '#13234a', '#1c2f6b', '#2a2457', '#3a2a3c'] : ['#ffffff', '#dbe6ff', '#b9c9fb', '#e6dcff', '#ffe4d2'];
  ['c0', 'c1', 'c2', 'c3', 'c4'].forEach(function (n, i) { gl.uniform3fv(gl.getUniformLocation(prog, n), hex(PAL[i])); });

  var SCALE = 0.5, visible = true, t0 = performance.now(), last = 0;
  function size() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(2, window.devicePixelRatio || 1) * SCALE;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uR, canvas.width, canvas.height);
  }
  function draw(now) {
    gl.uniform1f(uT, (now - t0) / 1000 + 40);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function frame(now) {
    if (!visible) return;
    // ~40fps is plenty for motion this slow and halves GPU work.
    if (now - last > 24) { draw(now); last = now; }
    requestAnimationFrame(frame);
  }
  size();
  if (reduce) { draw(performance.now()); canvas.classList.add('ready'); }
  else { requestAnimationFrame(function (n) { draw(n); canvas.classList.add('ready'); frame(n); }); }

  var rt;
  addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { size(); draw(performance.now()); }, 150); });
  function setVisible(v) { var was = visible; visible = v; if (v && !was && !reduce) requestAnimationFrame(frame); }
  if ('IntersectionObserver' in window) new IntersectionObserver(function (e) { setVisible(e[0].isIntersecting && !document.hidden); }).observe(canvas);
  document.addEventListener('visibilitychange', function () { setVisible(!document.hidden); });
})();
