<p align="center">
  <img src="piggy.png" width="280" alt="Piggy">
</p>

# Piggy

An open-source computer-use agent toolkit. 3D simulated mouse and keyboard that control your real cursor with human-like bezier paths and hardware-level input events.

Built with Electron, Three.js, and a custom C driver (CoreGraphics on macOS).

## What it does

### Tested and working
- **3D mouse + keyboard on a desk** — Three.js scene with LED glow, tilt physics, trail particles, keys that light up when pressed
- **3D monitor** — shows live screenshots of your screen inside the simulation
- **Human-like mouse movement** — bezier curves with micro-jitter and ease-in-out timing
- **Hardware-level input** — custom C driver using CoreGraphics `kCGHIDEventTap`. Events are indistinguishable from real hardware. Falls back to RobotJS if native driver isn't available
- **Key-by-key typing** — each character typed individually with human-like delays, handles special characters (@, #, etc.)
- **Action queue** — build sequences of move, click, type, key press, screenshot and execute them all in order
- **App focus** — select which app to target before executing. Focus happens first, then actions
- **Screenshot capture** — full screen or window-only, viewable on 3D monitor with history navigation

### Built but not yet tested with live API
- **AI agent** — vision model loop that sees screenshots and decides actions. Supports single and batch sequences. Conversation history with screenshot thumbnails sent between steps so the model remembers what it did
- **Multi-model support** — auto-detects provider from env: OpenAI (GPT-4o), Anthropic (Claude), Google (Gemini)
- **Accessibility API** — queries macOS for UI element positions by name. AI can find buttons, text fields, links without guessing from screenshots
- **Window management** — list, resize, move, minimize, close windows via System Events
- **Security confirmations** — dangerous actions (Cmd+Q, Cmd+W, sensitive text) trigger a confirmation dialog before executing
- **Skill system** — pluggable tools: clipboard read/write, safe shell commands, URL opening. Extensible with custom skills

## Setup

### macOS

```bash
git clone https://github.com/aidrissi1/Piggy.git
cd Piggy
npm install
cd native && npx node-gyp rebuild && cd ..
npx electron-rebuild
```

### Windows

RobotJS requires C++ build tools. Run in PowerShell as Administrator:
```
winget install Microsoft.VisualStudio.2022.BuildTools --force --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"
```
Then:
```bash
npm install
npx electron-rebuild
```
The native C driver is macOS-only. Windows uses RobotJS fallback automatically.

### Environment (optional, for AI features)

Create a `.env` file with one of these:
```
OPENAI_API_KEY=sk-your-key-here
# ANTHROPIC_API_KEY=sk-ant-your-key-here
# GEMINI_API_KEY=your-key-here
```
Piggy auto-detects which provider to use.

## Run

```bash
npm start
```

**macOS permissions needed:**
- **Accessibility** — System Settings → Privacy & Security → Accessibility → enable Terminal
- **Screen Recording** — System Settings → Privacy & Security → Screen Recording → enable Terminal

## Controls

| Key | Action |
|-----|--------|
| W/A/S/D | Move mouse |
| Space | Click |
| Q/E | Scroll up/down |
| Ctrl+Scroll | Zoom camera |
| Shift+Drag | Orbit camera |

### Panel tabs

- **Screen** — capture full screen or window, browse history with prev/next/delete
- **Action** — select target app, set coordinates, build a queue of actions, execute all
- **AI** — enter a task for the AI agent, watch each step with screenshots in chat view

## Architecture

```
input.js           — input abstraction: tries native C driver, falls back to RobotJS
native/            — C addon: CoreGraphics kCGHIDEventTap mouse/keyboard (macOS)
executor.js        — path execution, key-by-key typing, supervised movement
path-engine.js     — quadratic bezier curve generation with jitter and easing
main.js            — Electron main process, IPC handlers, screenshots, app focus
renderer.js        — Three.js 3D scene, UI logic, queue system, tab panel
ai-controller.js   — vision model loop with conversation history and batch support
model-provider.js  — multi-model abstraction: OpenAI, Anthropic, Gemini
accessibility.js   — macOS Accessibility API queries for UI element positions
windows.js         — window management: list, resize, move, minimize, close
skills.js          — pluggable skill system with built-in clipboard, shell, URL skills
index.html         — layout, styles, tabbed panel
```

## What's next

- Test AI agent with live API key
- Windows native C driver (SendInput)
- UI redesign — floating toolbar instead of side panel
- Memory engine — separate project for persistent AI context across sessions

## License

MIT — Idrissi
