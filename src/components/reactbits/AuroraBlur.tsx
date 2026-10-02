"use client";

/*
 * Aurora Blur background.
 * Adapted from React Bits Pro "aurora-blur-tw" (https://pro.reactbits.dev/docs/components/aurora-blur).
 * Same fragment shader as the original, rendered with the shared raw-WebGL runner instead of
 * three.js / @react-three/fiber. Decorative only: aria-hidden and no pointer events.
 */

import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { hexToRgb, useShaderCanvas } from "@/components/reactbits/useShaderCanvas";
import { BTC_AURORA_LAYERS, BTC_AURORA_SKY, type AuroraLayer, type SkyLayer } from "@/components/reactbits/aurora-presets";

export type { AuroraLayer, SkyLayer };


export interface AuroraBlurProps {
  className?: string;
  speed?: number;
  layers?: AuroraLayer[];
  skyLayers?: SkyLayer[];
  noiseScale?: number;
  movementX?: number;
  movementY?: number;
  verticalFade?: number;
  bloomIntensity?: number;
  brightness?: number;
  saturation?: number;
  opacity?: number;
}

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_speed;
uniform vec3 u_layer1Color; uniform float u_layer1Speed; uniform float u_layer1Intensity;
uniform vec3 u_layer2Color; uniform float u_layer2Speed; uniform float u_layer2Intensity;
uniform vec3 u_layer3Color; uniform float u_layer3Speed; uniform float u_layer3Intensity;
uniform vec3 u_layer4Color; uniform float u_layer4Speed; uniform float u_layer4Intensity;
uniform float u_noiseScale;
uniform float u_movementX;
uniform float u_movementY;
uniform float u_verticalFade;
uniform float u_bloomIntensity;
uniform vec3 u_skyColor1;
uniform vec3 u_skyColor2;
uniform float u_skyBlend1;
uniform float u_skyBlend2;
uniform float u_brightness;
uniform float u_saturation;
uniform float u_opacity;

float h(float n){return fract(sin(n)*43758.5453);}
float n2d(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
  return mix(mix(h(i.x+h(i.y)),h(i.x+1.+h(i.y)),u.x),
             mix(h(i.x+h(i.y+1.)),h(i.x+1.+h(i.y+1.)),u.x),u.y);
}
vec3 aurora(vec2 uv,float spd,float intensity,vec3 col,float aspect){
  float t=u_time*u_speed*spd;
  vec2 scaled=vec2(uv.x*aspect,uv.y)*u_noiseScale;
  vec2 p=scaled+t*vec2(u_movementX,u_movementY);
  float n=n2d(p+n2d(col.xy+p+t));
  float a=n-uv.y*u_verticalFade;
  return col*a*intensity*u_bloomIntensity;
}
vec3 sat(vec3 c,float s){
  float g=dot(c,vec3(0.299,0.587,0.114));
  return mix(vec3(g),c,s);
}
void main(){
  vec2 uv=vUv;
  float aspect=u_resolution.x/u_resolution.y;
  vec3 c=vec3(0.);
  c+=aurora(uv,u_layer1Speed,u_layer1Intensity,u_layer1Color,aspect);
  c+=aurora(uv,u_layer2Speed,u_layer2Intensity,u_layer2Color,aspect);
  c+=aurora(uv,u_layer3Speed,u_layer3Intensity,u_layer3Color,aspect);
  c+=aurora(uv,u_layer4Speed,u_layer4Intensity,u_layer4Color,aspect);
  c+=u_skyColor2*(1.-smoothstep(u_skyBlend1,1.,uv.y));
  c+=u_skyColor1*(1.-smoothstep(0.,u_skyBlend2,uv.y));
  c=sat(c,u_saturation)*u_brightness;
  // Change from the original: alpha follows brightness, so dark areas let the container's
  // CSS gradient (BTC navy) show through instead of painting black.
  float lum=max(c.r,max(c.g,c.b));
  float a=clamp(lum*1.6,0.,1.)*u_opacity;
  gl_FragColor=vec4(c/max(lum,0.001)*min(lum,1.),a);
}
`;

export default function AuroraBlur({
  className,
  speed = 1,
  layers = BTC_AURORA_LAYERS,
  skyLayers = BTC_AURORA_SKY,
  noiseScale = 3,
  movementX = -2,
  movementY = -3,
  verticalFade = 0.7,
  bloomIntensity = 1.8,
  brightness = 0.95,
  saturation = 1.05,
  opacity = 1,
}: AuroraBlurProps) {
  const rgb = useMemo(
    () => ({ layers: layers.map((l) => hexToRgb(l.color)), sky: skyLayers.map((s) => hexToRgb(s.color)) }),
    [layers, skyLayers],
  );

  const canvasRef = useShaderCanvas(FRAGMENT, (time, width, height) => {
    const u: Record<string, number | [number, number] | [number, number, number]> = {
      u_time: time,
      u_resolution: [width, height],
      u_speed: speed,
      u_noiseScale: noiseScale,
      u_movementX: movementX,
      u_movementY: movementY,
      u_verticalFade: verticalFade,
      u_bloomIntensity: bloomIntensity,
      u_skyColor1: rgb.sky[0] ?? [0, 0, 0],
      u_skyColor2: rgb.sky[1] ?? [0, 0, 0],
      u_skyBlend1: skyLayers[1]?.blend ?? 0,
      u_skyBlend2: skyLayers[0]?.blend ?? 0,
      u_brightness: brightness,
      u_saturation: saturation,
      u_opacity: opacity,
    };
    for (let i = 0; i < 4; i++) {
      u[`u_layer${i + 1}Color`] = rgb.layers[i] ?? [0, 0, 0];
      u[`u_layer${i + 1}Speed`] = layers[i]?.speed ?? 0;
      u[`u_layer${i + 1}Intensity`] = layers[i]?.intensity ?? 0;
    }
    return u;
  });

  return <canvas ref={canvasRef} aria-hidden="true" className={cn("pointer-events-none block h-full w-full", className)} />;
}
