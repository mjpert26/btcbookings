"use client";

/*
 * Silk Waves background.
 * Adapted from React Bits Pro "silk-waves-tw" (https://pro.reactbits.dev/docs/components/silk-waves).
 * The original renders through three.js; this version draws the same fragment shader on a
 * full-screen quad with raw WebGL so the app takes no extra dependency.
 *
 * Changes from the original:
 * - No three.js: plain WebGL 1 program, one triangle strip.
 * - prefers-reduced-motion: draws a single still frame and never animates.
 * - Pauses while the tab is hidden or the canvas is off screen.
 * - Falls back to the container's CSS gradient when WebGL is unavailable.
 * - Purely decorative: aria-hidden, pointer-events disabled.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export interface SilkWavesProps {
  speed?: number;
  scale?: number;
  distortion?: number;
  curve?: number;
  contrast?: number;
  /** Eight hex colors for the gradient, darkest first. */
  colors?: string[];
  rotation?: number;
  brightness?: number;
  opacity?: number;
  complexity?: number;
  frequency?: number;
  className?: string;
}

const vertexShader = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform float uSpeed;
uniform float uScale;
uniform float uDistortion;
uniform float uCurve;
uniform float uContrast;
uniform float uRotation;
uniform float uBrightness;
uniform float uOpacity;
uniform float uComplexity;
uniform float uFrequency;
uniform vec3 uC[8];
varying vec2 vUv;

vec2 rotate2D(vec2 p, float a) {
  float s = sin(a);
  float c = cos(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

void main() {
  vec2 pos = vUv * uScale;
  float aspect = uResolution.x / uResolution.y;
  pos.x *= aspect;
  vec2 center = vec2(aspect * 0.5 * uScale, 0.5 * uScale);
  pos = rotate2D(pos - center, uRotation) + center;

  float iterations = 10.0 + uComplexity * 10.0;
  for (float i = 1.0; i < 30.0; i++) {
    if (i > iterations) break;
    float t = uTime * uSpeed * 0.1 * i;
    float amp = 0.8 * uDistortion;
    float shift = 0.3 * uCurve;
    pos.x += amp / i * sin(i * pos.y + t + shift * i) + 1.6;
    pos.y += (amp * 2.0) / i * sin(pos.x + t + shift * i + 1.6) - 0.8;
  }

  float wave = cos((pos.x + pos.y) * uFrequency) * 0.5 + 0.5;
  vec3 col;
  if (wave < 0.15) col = mix(uC[0], uC[1], wave * 6.667);
  else if (wave < 0.35) col = mix(uC[1], uC[2], (wave - 0.15) * 5.0);
  else if (wave < 0.55) col = mix(uC[2], uC[3], (wave - 0.35) * 5.0);
  else if (wave < 0.7) col = mix(uC[3], uC[4], (wave - 0.55) * 6.667);
  else if (wave < 0.82) col = mix(uC[4], uC[5], (wave - 0.7) * 8.333);
  else if (wave < 0.92) col = mix(uC[5], uC[6], (wave - 0.82) * 10.0);
  else col = mix(uC[6], uC[7], (wave - 0.92) * 12.5);

  col *= uBrightness;
  float alpha = smoothstep(0.01, 1.0, pow(wave, 2.5 * uContrast)) * uOpacity;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

/** Default palette: BTC navy through BTC blue to sky. */
export const BTC_SILK_COLORS = ["#06223b", "#0b3d66", "#0b4f84", "#0d66a5", "#1479be", "#1b8fcf", "#22a4dc", "#5cbde6"];

export default function SilkWaves({
  speed = 0.6,
  scale = 2,
  distortion = 1,
  curve = 1,
  contrast = 1,
  colors = BTC_SILK_COLORS,
  rotation = 0,
  brightness = 1,
  opacity = 1,
  complexity = 1,
  frequency = 1,
  className,
}: SilkWavesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, vertexShader);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentShader);
    if (!vs || !fs) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform1f(u("uSpeed"), speed);
    gl.uniform1f(u("uScale"), scale);
    gl.uniform1f(u("uDistortion"), distortion);
    gl.uniform1f(u("uCurve"), curve);
    gl.uniform1f(u("uContrast"), contrast);
    gl.uniform1f(u("uRotation"), (rotation * Math.PI) / 180);
    gl.uniform1f(u("uBrightness"), brightness);
    gl.uniform1f(u("uOpacity"), opacity);
    gl.uniform1f(u("uComplexity"), complexity);
    gl.uniform1f(u("uFrequency"), frequency);
    const flat = new Float32Array(24);
    for (let i = 0; i < 8; i++) flat.set(hexToRgb(colors[i] ?? colors[colors.length - 1] ?? "#000000"), i * 3);
    gl.uniform3fv(u("uC"), flat);
    const uTime = u("uTime");
    const uRes = u("uResolution");

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let visible = true;
    const start = performance.now();
    // Start partway into the animation so the still frame is not the flat initial state.
    const offset = 12;

    function resize() {
      if (!canvas || !gl) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }

    function draw(t: number) {
      if (!gl) return;
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function frame() {
      draw(offset + (performance.now() - start) / 1000);
      raf = requestAnimationFrame(frame);
    }

    function sync() {
      cancelAnimationFrame(raf);
      raf = 0;
      resize();
      if (reduce.matches || document.hidden || !visible) {
        draw(offset);
      } else {
        raf = requestAnimationFrame(frame);
      }
    }

    const ro = new ResizeObserver(() => {
      resize();
      if (!raf) draw(offset);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      sync();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    reduce.addEventListener("change", sync);
    sync();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduce.removeEventListener("change", sync);
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [speed, scale, distortion, curve, contrast, colors, rotation, brightness, opacity, complexity, frequency]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("pointer-events-none block h-full w-full", className)} />;
}
