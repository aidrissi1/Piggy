<p align="center">
  <img src="piggy.png" width="280" alt="Piggy">
</p>

# Piggy

A 3D mouse simulator that controls your real cursor. Built with Electron + Three.js + RobotJS.

Piggy renders a 3D mouse on a virtual desk. When you move it — with keyboard or by entering coordinates — your real macOS cursor follows along a human-like bezier curve. It also captures full-screen screenshots for visual context.

## What works

- **3D mouse on a desk** — rendered with Three.js, LED glow, tilt physics, trail particles
- **WASD control** — move the 3D mouse and your real cursor follows
- **Move to coordinates** — enter X,Y, a bezier path is generated, mouse follows it with ease-in-out timing and micro-jitter
- **Click at coordinates** — moves to position then clicks
- **Screenshot capture** — captures full screen, displays on a 3D monitor in the scene and in the side panel with history navigation (prev/next/delete)
- **3D monitor** — a virtual screen on the desk shows the latest screenshot, like the AI's eyes
- **Path visualization** — planned path shows as a dotted green line on the 3D desk before execution
- **Camera control** — Shift+Scroll to zoom, Shift+Drag to rotate the view
- **Speed control** — adjustable movement speed slider
- **Stop button** — cancel any movement mid-path

## What's in progress

- **AI agent** — the architecture is built to connect a vision model (GPT-4o) that sees screenshots and decides where to move/click. The code is written but not yet tested with a live API key. Don't take our word for it until we confirm it works.

## Setup

```bash
git clone git@github.com:aidrissi1/piggy.git
cd piggy
npm install
npx electron-rebuild
```

Create a `.env` file (optional, only needed for AI features):
```
OPENAI_API_KEY=sk-your-key-here
```

## Run

```bash
npm start
```

**macOS permissions needed:**
- **Accessibility** — allows cursor control (System Settings → Privacy & Security → Accessibility → enable Terminal)
- **Screen Recording** — allows screenshots (System Settings → Privacy & Security → Screen Recording → enable Terminal)

## Controls

| Key | Action |
|-----|--------|
| W/A/S/D | Move mouse |
| Space | Click |
| Q/E | Scroll up/down |
| Shift+Scroll | Zoom camera in/out |
| Shift+Drag | Rotate camera |
| Tab | Toggle keyboard/AI mode indicator |

The right panel has manual controls: coordinate input for Move and Click, screenshot capture with history and delete, and an AI task input (requires API key).

## Tech

- **Electron** — desktop app shell
- **Three.js** — 3D rendering
- **RobotJS** — native cursor control
- **OpenAI SDK** — vision model integration (when API key is configured)

## Structure

```
main.js          — Electron main process, IPC handlers
renderer.js      — Three.js scene, UI logic, screenshot viewer
index.html       — Layout and styles
path-engine.js   — Bezier curve generation with jitter and easing
executor.js      — Supervised path execution with checkpoint support
ai-controller.js — Vision model loop (screenshot → decide → act → repeat)
```

## License

MIT — Idrissi
