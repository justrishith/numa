import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { ButterflyState } from "../components/Butterfly";

/* ------------------------------------------------------------------ shapes */

/** Right upper wing, in units where the body sits at x = 0. */
function upperWingShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0.03, 0.40);
  s.bezierCurveTo(0.22, 0.80, 0.80, 1.00, 1.32, 0.92);
  s.bezierCurveTo(1.86, 0.84, 1.98, 0.34, 1.54, 0.08);
  s.bezierCurveTo(1.12, -0.16, 0.42, -0.06, 0.03, 0.18);
  s.closePath();
  return s;
}

/** Right lower wing. */
function lowerWingShape(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0.03, 0.06);
  s.bezierCurveTo(0.34, -0.08, 0.72, -0.30, 0.84, -0.66);
  s.bezierCurveTo(0.94, -0.98, 0.56, -1.12, 0.30, -0.88);
  s.bezierCurveTo(0.10, -0.64, 0.02, -0.32, 0.03, -0.14);
  s.closePath();
  return s;
}

/**
 * Morpho colouring comes from a per-vertex ramp: bright electric blue in the
 * middle of the wing, near-black at the rim. That is what makes the edges read
 * as a black border without a second outline mesh.
 */
function gradientWing(shape: THREE.Shape, tint: THREE.Color): THREE.BufferGeometry {
  const geometry = new THREE.ShapeGeometry(shape, 28);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const count = position.count;

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < count; i += 1) {
    cx += position.getX(i);
    cy += position.getY(i);
  }
  cx /= count;
  cy /= count;

  let maxR = 0.0001;
  for (let i = 0; i < count; i += 1) {
    maxR = Math.max(maxR, Math.hypot(position.getX(i) - cx, position.getY(i) - cy));
  }

  const edge = new THREE.Color("#04060d");
  const mid = new THREE.Color("#0a3f9e");
  const colors = new Float32Array(count * 3);
  const temp = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    const d = Math.hypot(position.getX(i) - cx, position.getY(i) - cy) / maxR;
    const t = THREE.MathUtils.smoothstep(d, 0.42, 1.0);
    if (t < 0.5) {
      temp.copy(tint).lerp(mid, t * 2);
    } else {
      temp.copy(mid).lerp(edge, (t - 0.5) * 2);
    }
    colors[i * 3] = temp.r;
    colors[i * 3 + 1] = temp.g;
    colors[i * 3 + 2] = temp.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ motion */

interface Motion {
  speed: number;
  amplitude: number;
  lift: number;
}

const MOTION: Record<ButterflyState, Motion> = {
  idle: { speed: 1.7, amplitude: 0.86, lift: 0.06 },
  listening: { speed: 3.4, amplitude: 1.0, lift: 0.08 },
  working: { speed: 5.4, amplitude: 1.12, lift: 0.1 },
  approval: { speed: 7.6, amplitude: 1.24, lift: 0.12 },
  success: { speed: 2.3, amplitude: 0.8, lift: 0.14 },
  error: { speed: 0.9, amplitude: 0.38, lift: 0.02 },
};

const CORE_COLOR: Record<ButterflyState, string> = {
  idle: "#8b7cff",
  listening: "#4fe3ff",
  working: "#9a8cff",
  approval: "#ffb84d",
  success: "#4fe0c8",
  error: "#ff5c7a",
};

/* ------------------------------------------------------------------ pieces */

function Wing({
  shape,
  tint,
  mirrored,
  flapRef,
}: {
  shape: THREE.Shape;
  tint: THREE.Color;
  mirrored: boolean;
  flapRef: React.RefObject<THREE.Group | null>;
}) {
  const geometry = useMemo(() => gradientWing(shape, tint), [shape, tint]);

  return (
    <group ref={flapRef} scale={[mirrored ? -1 : 1, 1, 1]}>
      <mesh geometry={geometry} castShadow>
        <meshPhysicalMaterial
          vertexColors
          side={THREE.DoubleSide}
          roughness={0.24}
          metalness={0.46}
          clearcoat={1}
          clearcoatRoughness={0.16}
          emissive={new THREE.Color("#0b4fd8")}
          emissiveIntensity={0.34}
        />
      </mesh>
      {/* thin structural veins, barely visible but they catch the light */}
      <mesh geometry={geometry} position={[0, 0, 0.004]} scale={[0.985, 0.985, 1]}>
        <meshBasicMaterial
          color="#8fc8ff"
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Antenna({ mirrored }: { mirrored: boolean }) {
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.03, 0.62, 0),
      new THREE.Vector3(0.12, 0.86, 0.02),
      new THREE.Vector3(0.26, 1.02, 0.03),
      new THREE.Vector3(0.38, 1.10, 0.02),
    ]);
    return new THREE.TubeGeometry(curve, 20, 0.008, 6, false);
  }, []);

  return (
    <group scale={[mirrored ? -1 : 1, 1, 1]}>
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#0a1020" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[0.38, 1.10, 0.02]}>
        <sphereGeometry args={[0.026, 12, 12]} />
        <meshBasicMaterial color="#bfe3ff" />
      </mesh>
    </group>
  );
}

function Butterfly({ state }: { state: ButterflyState }) {
  const root = useRef<THREE.Group>(null);
  const rightUpper = useRef<THREE.Group>(null);
  const leftUpper = useRef<THREE.Group>(null);
  const rightLower = useRef<THREE.Group>(null);
  const leftLower = useRef<THREE.Group>(null);
  const phase = useRef(0);
  const drift = useRef(0);

  const tint = useMemo(() => new THREE.Color("#2e9bff"), []);
  const upper = useMemo(upperWingShape, []);
  const lower = useMemo(lowerWingShape, []);

  const motion = MOTION[state];

  useFrame((_, delta) => {
    const step = Math.min(delta, 0.05);
    phase.current += step * motion.speed;
    drift.current += step;

    const swing = Math.sin(phase.current) * motion.amplitude;
    // Wings hinge on the body axis, so the tips sweep toward the camera.
    if (rightUpper.current) {
      rightUpper.current.rotation.y = -swing * 0.95;
      rightUpper.current.rotation.z = -swing * 0.12;
    }
    if (leftUpper.current) {
      leftUpper.current.rotation.y = swing * 0.95;
      leftUpper.current.rotation.z = -swing * 0.12;
    }
    if (rightLower.current) {
      rightLower.current.rotation.y = -swing * 0.62;
    }
    if (leftLower.current) {
      leftLower.current.rotation.y = swing * 0.62;
    }

    if (root.current) {
      const t = drift.current;
      root.current.position.y = Math.sin(t * 0.9) * motion.lift;
      root.current.position.x = Math.sin(t * 0.42) * 0.26;
      root.current.rotation.z = Math.sin(t * 0.7) * 0.07;
      root.current.rotation.x = Math.sin(t * 0.55) * 0.05;
    }
  });

  return (
    <group ref={root} scale={0.95}>
      <Wing shape={upper} tint={tint} mirrored={false} flapRef={rightUpper} />
      <Wing shape={upper} tint={tint} mirrored flapRef={leftUpper} />
      <Wing shape={lower} tint={tint} mirrored={false} flapRef={rightLower} />
      <Wing shape={lower} tint={tint} mirrored flapRef={leftLower} />

      {/* body */}
      <mesh position={[0, 0.28, 0]}>
        <sphereGeometry args={[0.11, 20, 20]} />
        <meshStandardMaterial color="#0b1120" roughness={0.42} metalness={0.5} />
      </mesh>
      <mesh position={[0, -0.02, 0]} scale={[0.75, 1, 0.75]}>
        <capsuleGeometry args={[0.085, 0.72, 8, 16]} />
        <meshStandardMaterial color="#0a0f1c" roughness={0.38} metalness={0.55} />
      </mesh>
      <mesh position={[0, 0.55, 0.01]}>
        <sphereGeometry args={[0.075, 16, 16]} />
        <meshStandardMaterial
          color="#0d1526"
          roughness={0.3}
          metalness={0.6}
          emissive={new THREE.Color(CORE_COLOR[state])}
          emissiveIntensity={0.7}
        />
      </mesh>

      <Antenna mirrored={false} />
      <Antenna mirrored />
    </group>
  );
}

function Glow({ state }: { state: ButterflyState }) {
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(150,200,255,0.85)");
    gradient.addColorStop(0.3, "rgba(70,130,255,0.35)");
    gradient.addColorStop(0.65, "rgba(30,60,180,0.12)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }, []);

  const ref = useRef<THREE.Sprite>(null);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 0.9 + Math.sin(clock.elapsedTime * 1.4) * 0.12;
    ref.current.scale.setScalar(4.6 * pulse);
  });

  const color = useMemo(() => new THREE.Color(CORE_COLOR[state]), [state]);

  if (!texture) return null;

  return (
    <sprite ref={ref} position={[0, 0.15, -0.9]}>
      <spriteMaterial
        map={texture}
        color={color}
        transparent
        opacity={0.55}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </sprite>
  );
}

function Dust() {
  const ref = useRef<THREE.Points>(null);
  const geometry = useMemo(() => {
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 8 - 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.012;
    ref.current.position.y = Math.sin(clock.elapsedTime * 0.18) * 0.25;
  });

  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial
        size={0.018}
        color="#9db4ff"
        transparent
        opacity={0.5}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ------------------------------------------------------------------ scene */

export function ButterflyCanvas({ state }: { state: ButterflyState }) {
  const core = CORE_COLOR[state];

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.05, 6.4], fov: 38 }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 5, 4]} intensity={1.5} color="#dbe8ff" />
      <directionalLight position={[-4, -2, 3]} intensity={0.7} color="#4f7dff" />
      <pointLight position={[0, 0.4, 2.6]} intensity={9} distance={9} color={core} />
      <pointLight position={[0, -1.2, -3]} intensity={7} distance={12} color="#1f4fff" />

      <Glow state={state} />
      <Butterfly state={state} />
      <Dust />
    </Canvas>
  );
}
