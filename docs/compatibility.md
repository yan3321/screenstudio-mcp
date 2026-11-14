# Screen Studio 4 compatibility

Supported app build: **4.1.0-5005**. Project schema: **4.0.0**. Exercised on Apple Silicon macOS.

| Surface | Coverage | Exercised |
| --- | --- | --- |
| Connection | Port auto-detection, editor renderer selection | Real app |
| Sources and state | Window/display IDs, devices, live recording state | Real app |
| Recording | Start exact window, pause/resume, add markers (read back in source ms by `screenstudio_analyze`), finish into a project | Real app |
| Native walkthrough | Focus, human-paced glide/click/double-click/drag, typing, shortcuts, smooth scroll, one-take beats | Real sample app |
| Live editor | Find open editors, pre-checked project opens, slices, zooms (`instant`), expanded layouts, 4.1.0 config fields, UI view panels and toggles, undo, checkpoints, save after each apply | Real app, real footage copy |
| Preview frames | Editor preview capture at playback times | Real app |
| Analysis | Clicks, drags, typing, shortcuts, movement, screen changes, idle, multi-session | Window and display recordings |
| Planning and pacing | Calm/balanced/snappy plans, pacing check | Unit tests plus real footage |
| Export | Local MP4 (`h264`/`h265`/`both`), ProRes (`.mov`), and GIF (`gifDisableLoop`) from live or disk project data, job lifecycle, delivery, encoded inspection | Real app: MP4 (including dual H.264/HEVC), ProRes MOV, and GIF |
| Narration | Neural voice lines pinned to source time, mixed over library music with ducking, attached as the project's background audio track | Real app, exported with audio |
| Click sounds, ripple, springs, background, loupe | Supported config and zoom fields | Real app, exported |
| Transcript and captions | On-device generation, read, word fixes, full caption styling, live editor refresh | Real app, real speech recording |
| Camera layouts and cutout | Default layout settings and layout track items; 4.1.0 `edgeInsetPx` and `delayAdjustmentMs` are applied and read back live, but their rendered effect is not yet checked against a camera recording | Real app, exported |
| Masks and processing | Sensitive-data/highlight masks and auto-masking/face-blur `processing` config fields | Real app, real footage copy |
| Crop, backdrop, device frames, cursor sets | Any project setting, checked against the live config (`directional` rotation, `channel-fix` mic preset, etc.) | Real app, exported |
| Music | Library tracks ducked under transcript speech; shares the background audio track with narration | Real app, exported |
| Webcam/audio effects | Supported nested settings | Schema mapped |
| Export height | Targets and recipes carry the frame's short side (1080 for 1080x1920 at 9:16). Screen Studio reads export height as the frame's height, so `renderHeight` converts the short side for portrait frames (a 9:16 frame at 1080 asks for 1920, 4:5 asks for 1350) | Confirmed by a live portrait render (606x1080 before the fix); the post-render resolution check names the frame it wanted |
| Brand presets | `screenstudio_brand` `toPreset` calls the app's `presets.createFromConfig` with `presetName` and reports when the build lacks it | Real app |
| Camera presence | Read loosely from the recording's channels (a `camera` or `webcam` type); unknown keeps the old behaviour | Not yet checked against a real camera recording |
| Presets | Create, list, sync, rename, import (`.screenstudiopreset` packages/files), delete, and apply presets (`screenstudio_presets`). Refuses applying to an open editor | Real app |
| Custom LUTs and assets | Global LUT library (`screenstudio_luts` add/list/remove) and per-project image/audio/LUT assets (`screenstudio_project_asset`) | Real app |
| Projects and import | Recent project listing with bundle validation (`screenstudio_projects`), video import (`screenstudio_project_import`), duplicate, `extractRaw`, copy, move, remove (`screenstudio_project_manage`) | Real app |
| Recovery and window control | Unfinished recording recovery (`screenstudio_record_recover`) and window focus/resize (`screenstudio_window`) | Real app: `list`, `focus` and `resize` (`640x480` on a test window). `recover` and `discard` path containment and error handling have unit tests (`service.test.mjs`), not run live against an unfinished recording |
| Screen Studio AI voiceover and recorded voiceover tracks | Disabled by the app in this build ("not enabled"); narration uses the audio track instead | Inspected |

The app's local bridge and editor model are undocumented. A different build is rejected before any change, so turn off Screen Studio's auto-update. `SCREENSTUDIO_ALLOW_UNTESTED=1` lets edits run on an untested 4.x build at your own risk; reads always work. To add a build: inspect its state and editor model, run the unit tests and a seeded record-edit-export pass, then update this table.

Vendor code is not in this repository. Screen Studio is installed and licensed separately.
