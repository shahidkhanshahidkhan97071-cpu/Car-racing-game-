# ASPHALT FOREST — browser arcade racer

Arcade street racing built **only from your own GLB assets** (Lamborghini Asterion LPI 910-4 + 5 forest tree models).
Custom WebGL2 engine — no downloads, no internet needed, nothing to install.

## How to start

1. Unzip the folder anywhere.
2. **Double-click `start_game.bat`** — it starts a small local server and opens the game in your browser.
   (It tries Python → Node.js → PowerShell, so it works on a stock Windows 10/11.)
3. Keep the black window open while you play. Close it to stop.

> Don't open `index.html` directly (browsers block modules from `file://`). Always use `start_game.bat`.
> Mac/Linux: `python3 tools/server.py`

Best in **Chrome / Edge** with hardware acceleration ON (a dedicated GPU is recommended for High/Ultra).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate | W / ↑ | RT |
| Brake / reverse | S / ↓ | LT |
| Steer | A D / ← → | Left stick |
| Handbrake (drift) | Space | X / RB |
| Nitro | Shift / N | A / B |
| Camera (chase / close / bumper) | C | Y |
| Reset on track | R | Back |
| Pause | Esc / P | Start |
| Mute | M | |

**Tips:** drifting (brake or handbrake while turning) fills the nitro bar. Release a long drift for a free boost.
Hold the throttle just before “GO!” for a **perfect start**.

## Game content

* 3 tracks — **Pine Valley** (golden hour), **Red Oak Ridge** (misty morning), **Black Spruce Night** (wet night run with street lamps + headlights)
* 1–8 laps, 0–7 AI opponents, 4 difficulty levels (rubber-band AI with mistakes, overtaking, nitro use)
* Garage with 10 paint colours, per-car stats
* Procedural engine / tyre / nitro / wind audio and a synth music loop (all generated live)
* Quality presets Low / Medium / High / Ultra + automatic dynamic resolution (keeps ~60 fps)

## Graphics quality

Assets are used at full quality: all GLB textures are kept (up to 2048 px), PBR materials with normal / metal-rough / AO maps,
image based lighting, cascaded-style soft sun shadows, MSAA, HDR bloom and tone mapping.
If the game is slow: Settings → **Medium** or **Low**. Quality changes apply at the next race start.

## Adding more cars (later)

1. Put the new car `.glb` into the **`cars/`** folder.
2. Restart the game (`start_game.bat`). The car appears in **GARAGE** automatically (use ‹ › to switch).
3. Optional: create a text file with the same name, e.g. `cars/my_car.json`:

```json
{
  "name": "My Car Name",
  "yaw": 0,
  "scale": 1,
  "stats": { "topSpeed": 90, "accel": 1.1, "handling": 1.0, "grip": 1.0, "nitro": 1.0, "brake": 1.0 }
}
```

* `topSpeed` is in m/s (86 ≈ 310 km/h). Other stats are multipliers around 1.0.
* `yaw` – rotate the model in degrees if it faces the wrong way (the car must face **+Z**; try `180` or `90`).
* `scale` – only needed if the car is not auto-detected at a realistic size (the loader normalises to ~4.6 m length).
* The loader auto-detects wheels (nodes named *wheel*), body paint (materials named *paint / body / exterior*), glass, rims, tyres,
  head- and tail-lights. Name things like that in your model for the best result.

Opponents randomly use any car found in the `cars/` folder.

## Folder layout

```
start_game.bat        ← double-click this
index.html, css/, js/ ← the game
cars/                 ← drop car .glb files here
assets/               ← tree models (GLB)
tools/                ← tiny local servers (python / node / powershell)
```

## Credits

3D models are the property of their respective authors (as supplied by you); check each model's license
(e.g. CC-BY requires crediting the author) before publishing the game anywhere.
