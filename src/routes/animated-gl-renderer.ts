// === WebGL2 Animated Renderer ===
// Renders ONLY the "animated" pixel buffer (the RGBA byte array produced each frame for strokes
// that are still live-animating) as one textured quad on its own <canvas>, stacked on top of the
// existing main canvas (which keeps handling everything else — background, static/frozen strokes,
// Selection, Fill, Export — completely unchanged, via its own existing Canvas2D/Pixi path).
//
// This module owns exactly: one WebGL2 context, one shader program, one VAO/vertex buffer, one
// texture. Nothing here touches brush math, layer compositing, undo/redo, or export — callers
// simply hand it a finished RGBA buffer once per frame (or don't call update() at all on frames
// where nothing animated changed) and it uploads + draws that buffer as-is.
//
// Fallback: getAnimatedGLRenderer() returns null when WebGL2 isn't available (old/blocked GPU,
// browser flag, etc.) or context creation throws. Callers are expected to fall back to rendering
// animated strokes straight into the existing CPU buffer/Canvas2D-via-Pixi path in that case —
// i.e. exactly the behavior this feature branches off of, untouched.

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("Shader compile error: " + log);
  }
  return sh;
}

export interface AnimatedGLRenderer {
  /** True size (in device pixels) the texture is currently allocated for. */
  readonly texW: number;
  readonly texH: number;
  /**
   * Upload a fresh RGBA frame (straight, non-premultiplied alpha — same convention the rest of the
   * app's pixel buffers already use) into the existing GPU texture. Reuses the same WebGLTexture
   * every call (texSubImage2D, not a new texImage2D/allocation) — the texture is only ever
   * reallocated by resize(). Callers should only call this on frames where the animated buffer
   * actually changed (see requirement: skip GPU upload when nothing animated this frame).
   */
  update(data: Uint8ClampedArray, w: number, h: number): void;
  /** Clears the canvas to fully transparent — used on frames with no animated content to show. */
  clear(): void;
  /** Draws the current texture as a fullscreen (of this canvas) alpha-blended quad. */
  draw(): void;
  /** Resizes the backing canvas + texture. Cheap no-op if the size is unchanged. */
  resize(w: number, h: number): void;
  /** Releases the GL program, buffers, VAO and texture. Safe to call multiple times. */
  destroy(): void;
}

/**
 * Creates a WebGL2-backed renderer bound to `canvas`. Returns null (never throws) if WebGL2 isn't
 * supported — callers should treat that as "use the existing Canvas2D/Pixi animated-stroke path
 * instead" and never call any method on a null result.
 */
export function getAnimatedGLRenderer(canvas: HTMLCanvasElement): AnimatedGLRenderer | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const gl2 = gl; // non-null from here

  let program: WebGLProgram;
  let vao: WebGLVertexArrayObject | null;
  let vbo: WebGLBuffer | null;
  let texture: WebGLTexture | null;
  try {
    const vs = compileShader(gl2, gl2.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl2, gl2.FRAGMENT_SHADER, FRAGMENT_SRC);
    const prog = gl2.createProgram();
    if (!prog) throw new Error("createProgram failed");
    gl2.attachShader(prog, vs);
    gl2.attachShader(prog, fs);
    gl2.linkProgram(prog);
    if (!gl2.getProgramParameter(prog, gl2.LINK_STATUS)) {
      const log = gl2.getProgramInfoLog(prog);
      gl2.deleteProgram(prog);
      throw new Error("Program link error: " + log);
    }
    // Shaders are already linked into the program; the standalone shader objects aren't needed
    // after this, so free them immediately instead of leaking them for the renderer's lifetime.
    gl2.deleteShader(vs);
    gl2.deleteShader(fs);
    program = prog;

    // Fullscreen quad (two triangles) in clip space, with matching UVs. Flip V so the texture's
    // row 0 (top of the RGBA buffer, same layout every other buffer in this app already uses)
    // lands at the top of the canvas — canvas/ImageData convention vs GL's bottom-left origin.
    // prettier-ignore
    const verts = new Float32Array([
      // x,    y,     u,   v
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
      -1,  1,  0, 0,
       1, -1,  1, 1,
       1,  1,  1, 0,
    ]);
    vao = gl2.createVertexArray();
    vbo = gl2.createBuffer();
    if (!vao || !vbo) throw new Error("createVertexArray/createBuffer failed");
    gl2.bindVertexArray(vao);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, vbo);
    gl2.bufferData(gl2.ARRAY_BUFFER, verts, gl2.STATIC_DRAW);
    gl2.enableVertexAttribArray(0);
    gl2.vertexAttribPointer(0, 2, gl2.FLOAT, false, 16, 0);
    gl2.enableVertexAttribArray(1);
    gl2.vertexAttribPointer(1, 2, gl2.FLOAT, false, 16, 8);
    gl2.bindVertexArray(null);

    texture = gl2.createTexture();
    if (!texture) throw new Error("createTexture failed");
    gl2.bindTexture(gl2.TEXTURE_2D, texture);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.NEAREST);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.NEAREST);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE);
    gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE);
  } catch {
    // Any failure during setup (older WebGL2 impl missing a feature, context lost mid-init, etc.)
    // — surface it the same way "unsupported" is surfaced, so the caller falls back cleanly.
    return null;
  }

  let texW = 0, texH = 0;
  const uTexLoc = gl2.getUniformLocation(program, "u_tex");

  function resize(w: number, h: number) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl2.viewport(0, 0, w, h);
    if (w === texW && h === texH) return;
    gl2.bindTexture(gl2.TEXTURE_2D, texture);
    // Allocate (but don't yet fill) the texture at the new size — update() below fills it via
    // texSubImage2D, which is the only per-frame GPU upload call, keeping this allocation itself
    // a resize-only cost rather than a per-frame one.
    gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, w, h, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, null);
    texW = w; texH = h;
  }

  function update(data: Uint8ClampedArray, w: number, h: number) {
    if (w !== texW || h !== texH) resize(w, h);
    gl2.bindTexture(gl2.TEXTURE_2D, texture);
    gl2.pixelStorei(gl2.UNPACK_FLIP_Y_WEBGL, false);
    gl2.texSubImage2D(gl2.TEXTURE_2D, 0, 0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, data);
  }

  function clear() {
    gl2.clearColor(0, 0, 0, 0);
    gl2.clear(gl2.COLOR_BUFFER_BIT);
  }

  function draw() {
    gl2.clearColor(0, 0, 0, 0);
    gl2.clear(gl2.COLOR_BUFFER_BIT);
    gl2.enable(gl2.BLEND);
    // Straight (non-premultiplied) alpha "over" blend — same math compositeBakedStroke/
    // blendIsoPixel already use elsewhere in the app for animated-over-static compositing, so the
    // visual result matches the previous CPU-composited path exactly.
    gl2.blendFuncSeparate(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA, gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA);
    gl2.useProgram(program);
    gl2.activeTexture(gl2.TEXTURE0);
    gl2.bindTexture(gl2.TEXTURE_2D, texture);
    gl2.uniform1i(uTexLoc, 0);
    gl2.bindVertexArray(vao);
    gl2.drawArrays(gl2.TRIANGLES, 0, 6);
    gl2.bindVertexArray(null);
    gl2.disable(gl2.BLEND);
  }

  function destroy() {
    if (vao) gl2.deleteVertexArray(vao);
    if (vbo) gl2.deleteBuffer(vbo);
    if (texture) gl2.deleteTexture(texture);
    if (program) gl2.deleteProgram(program);
    vao = null; vbo = null; texture = null;
  }

  return {
    get texW() { return texW; },
    get texH() { return texH; },
    update, clear, draw, resize, destroy,
  };
}
