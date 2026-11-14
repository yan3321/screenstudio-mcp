# Screen Studio coverage

Every editor command and workflow in Screen Studio (tested against `4.1.0-5005`), and how the MCP does it. Commands are thin wrappers over the project model; the MCP drives the same model, so results match the app.

## Recording

| Screen Studio | MCP |
| --- | --- |
| Record display, window, area, or external device (iOS) | `screenstudio_record_start` (displayId, windowId, externalDeviceId, area, hideDesktopIcons) |
| Pause, resume, finish, restart, cancel, add marker | `screenstudio_record_control`; `screenstudio_desktop_perform` markers adds one per beat, `screenstudio_analyze` reads them back in source ms |
| Bring window to front or resize window to exact points | `screenstudio_window` (focus, resize) |
| Recover or discard unfinished recordings | `screenstudio_record_recover` (list, recover, discard) |
| Recording widget, speaker notes prompter | App UI only |

## Exact editor inspection

`screenstudio_editor_snapshot` reads one complete native project serialization with exact fractional times,
per-clip flags, a versioned canonical revision fingerprint and explicit private-phrase redactions. It does not
edit, focus or save project data. Fingerprints are opaque SDK-computed values; V2 follows JavaScript JSON number formatting and UTF-16 key ordering. V3 (`revisionBasis: native-edit`) additionally excludes the tested build's serialized playback-position preference, which seeking changes without an edit. The exact snapshot still includes that preference. Untested readable builds retain V2 (`revisionBasis: serialized-content`); V1 export hashing is unchanged. Do not recompute fingerprints with Python JSON. Native revision fingerprints use private local SDK integrity state; version, algorithm or keyId changes require reconciliation, and redacted projects expose no legacy unkeyed export hash. Non-finite values are refused; undefined object fields are omitted and negative zero normalizes to zero. Existing `screenstudio_editor_state` remains the convenient rounded display view.

`screenstudio_editor_mutate` applies a synchronous, unpaced batch with a caller mutation ID and V3 content precondition. Its renderer verifies that content before editing, captures exact pre/post state before yielding, and saves only the captured post-state. The HMAC authority stays server-side. Returned receipts contain keyed identities and operation results; private full-state captures are never persisted or returned by these tools. A partial batch remains live and is not automatically restored.

`screenstudio_editor_receipt` recovers the same mutation's evidence after a lost response or SDK restart. An immutable, fsynced request-bound intent is published before renderer dispatch. Reusing an ID returns its evidence, and changing its request is refused. Wait for `phase: complete` before advancing a revision chain; an in-progress duplicate can return `preparing` or `saving`. If the app loses its receipt before durable acknowledgement, the intent returns `phase: unresolved`, `status: unknown`; the SDK never dispatches that ID again. The expected fingerprint on an unresolved intent is not an observed pre-state. `found: false` or a transport error never proves that no mutation happened. Explicit reconciliation is required for unresolved outcomes. These tools are the revision primitive; the older paced apply/checkpoint API retains its existing contract and is not a replacement for this content fence.

Renderer refusal before mutation returns terminal `notApplied` evidence; `beforeFingerprint` is omitted when the project could not be captured. A connection failure proven to precede command dispatch returns `notDispatched`. Transient receipt-query failure is separately `awaitingReceipt` / `rendererUnavailable` / `retryable: true`; reachable-but-missing receipts return `unresolved` / `receiptAbsent`. Neither dispatches an edit again. Completed receipts are recovered at server startup when possible, then large private renderer captures are replaced by small request-bound acknowledgements. Mutation evidence is retained rather than age-pruned.

Mutation IDs normalize to lowercase, and new mutations require the tested app build even when general untested-build access is enabled. An empty `ops` array with `save:true` is a fenced save of the captured current state. It can save a prior unsaved edit only when the expected fingerprint still matches; ordinary `editor_save` instead saves the current live model. Unknown pending saves must settle or be reconciled before another save is attempted. Partial results include sanitized operation failure codes. Additional private-value redactions make `projectExact:false` and report a count rather than structural paths; adoption must refuse those incomplete projections.

## Timeline: cuts and speed

| Screen Studio | MCP (`screenstudio_editor_apply` ops) |
| --- | --- |
| Split at current time | `splitAt` |
| Remove slice, remove slice till previous cut | `removeSlice`, `cutRange` |
| Merge slice with next / previous | `mergeSlices` |
| Set slice speed, apply speed to all slices | `updateSlice` speed, `setSlices` |
| Set slice volume, system audio volume, external device volume | `updateSlice` (0–1) |
| Hide mouse cursor, disable smooth mouse movement (per slice) | `updateSlice` |
| Reset slice trim, reset trims and cuts for all slices | `resetCuts`, `setSlices` |
| Edit by transcript (cut words) | `cutRange` on word times from `screenstudio_transcript_read`; `screenstudio_plan_edit` removeFillers and tightenPausesMs |

## Zooms and loupe

| Screen Studio | MCP |
| --- | --- |
| Add zoom, remove zoom, duplicate zoom | `addZoom`, `removeZoom`, `duplicateItem` |
| Change / increase / decrease zoom level, apply level to all | `updateZoom` |
| Set zoom to auto / manual | `updateZoom` follow |
| Toggle loupe mode, loupe radius / bevel / aberration / glass | `updateZoom` presentation and loupe |
| Toggle zoom disabled, disable / enable all zooms | `updateItem` fields isDisabled, `setTrackDisabled` |
| Remove all zooms, restore default (auto) zooms | `clearZooms`, `restoreAutoZooms` |
| Start zoom animation early, zoom springs, motion blur | `config` zooms.*, animations.* |

## Camera layouts, masks, voiceovers

| Screen Studio | MCP |
| --- | --- |
| Default layout (camera overlay, split screen, cutout camera) and its options | `config` defaultLayout.* |
| Layout changes on the timeline (incl. fullscreen camera, screen only) | `addLayout`, `updateItem`, `removeItem`, `clearTrack` layouts; planned from speech by `screenstudio_plan_layouts` |
| Camera style: mirror, face tracking, LUT, grain, sharpen, crop, background blur, cutout edge, hide during silence | `config` camera.* |
| Add sensitive data / highlight mask, change type, opacity, disable, remove all | `addMask`, `updateItem`, `setTrackDisabled`, `clearTrack` masks |
| Find private text on screen and propose blur masks (MCP only) | `screenstudio_find_sensitive` |
| Remove voiceover(s) | `removeItem` / `clearTrack` voiceOvers |
| AI voiceover, recorded voiceover | Disabled in this app build; `screenstudio_narrate` adds narration on the audio track |

## Look and sound

| Screen Studio | MCP |
| --- | --- |
| Background: wallpaper, gradient, color, custom image, blur; padding; radius; shadow; inset | `config` styles.*, output.*, `screenstudio_catalog` wallpapers, `screenstudio_project_asset` addImage |
| Custom 3D LUT library and project LUT / audio / image assets | `screenstudio_luts` (list, add, remove), `screenstudio_project_asset` (addImage, addAudio, addLut, removeAsset) |
| Crop | `config` crop.rect01 |
| Output aspect ratio, avoid empty zoom area | `config` output.* |
| Device frame | `config` device.*, catalog deviceFrames |
| Cursor: set, size, hide, idle hide, rotation, shake, click effect, loop, stop at end | `config` cursor.*, catalog cursorSets |
| Captions: transcript on/off, font, size, colors, position, reveal, line growth, entrance, sound labels | `config` captions.* |
| Keyboard shortcut keycaps | `config` captions.enableShortcuts, captions.hiddenShortcuts, shortcutsSizeRatio, showShortcutsWithSingleLetters |
| Generate / edit transcript | `screenstudio_transcript_generate`, `screenstudio_transcript_edit` |
| Audio: volume, mic preset, mutes, improve quality | `config` audio.*, processing.* |
| Click sound effects | `config` audio.clickSoundEffect, clickSoundEffectVolume |
| Background music library | `screenstudio_music` (ducked under speech), or the `music` option of `screenstudio_narrate`; both write the one background audio track |
| Presets: list, apply, create, sync, rename, import, delete | `screenstudio_presets` |
| Validate preset source without importing | `screenstudio_preset_validate` |
| Validate config values without editing; defer unknown fields or check a live reference | `screenstudio_config_validate` |
| Brand colours, captions, cursor and sound saved once | `screenstudio_brand` (one live config op, plus toPreset) |

## Editor interface and playback

| Screen Studio | MCP |
| --- | --- |
| Recent projects list, import external video, move/copy/extractRaw/delete project | `screenstudio_projects`, `screenstudio_project_import`, `screenstudio_project_manage` |
| Play, pause, go to first / last frame, move by frames, play speed | `screenstudio_editor_play`, `screenstudio_editor_seek` |
| Undo, redo | `screenstudio_editor_history` |
| Save, save as | `screenstudio_editor_save` (each apply also saves unless `save: false`), `screenstudio_project_duplicate` |
| Open sidebar panels and tool windows | `screenstudio_editor_view` panel (background, cursor, cameraLayout, cameraStyle, captions, transcript, shortcuts, audio, animation, deviceFrame), cropWindow, lutStudio, shortcutsGuide |
| Select an item, timeline zoom in / out, show / hide sidebar and timeline, preview mode | `screenstudio_editor_view` |
| Export current frame as image | `screenstudio_editor_frame` |
| Export to file (MP4 H.264/HEVC/both, ProRes .mov, GIF) | `screenstudio_export_start` |
| Export for several destinations, with posters, captions, chapters and a manifest | `screenstudio_export_variants` |
| Looping hero video and README GIF | `screenstudio_loop` |
| Review every key moment at once | `screenstudio_contact_sheet` |

## Beyond the app (MCP only)

| Capability | MCP |
| --- | --- |
| Fit an edit to a length, structure it hook-demo-payoff, cut to the beats marked while recording, director's notes for every decision | `screenstudio_plan_edit` targetMs, structure, markers; returns beats, droppedBeats, coldOpen, notes |
| Optional presets: one word for a whole direction (pacing, frame, captions, sound, music, voice, export targets) | `screenstudio_recipes`, `recipe` on `screenstudio_plan_edit`, `screenstudio_check_pacing` and `screenstudio_export_variants` |
| Brand kit over a recipe | `brand` on `screenstudio_plan_edit`, or `recipeOverrides.brand` |
| Voice the script first and size each beat to its line | `screenstudio_voice_lines`, then `screenstudio_desktop_perform` minDurationMs and `screenstudio_narrate` pinToMarkers |
| Captions for an AI voice | `screenstudio_narrate` captions (the app's own captions, or SRT and styled ASS files) |

## Not automated

Shareable links and share project (upload to the cloud), export to clipboard and cut/copy/paste between projects (touches the clipboard), license, subscription and account, check for updates, settings dialog, onboarding, diagnostics and debug commands, reel preview mode, preview size and resolution.

### Save observations and pending writes

Native editor saves return within a renderer deadline. `saved:true` confirms the captured state was written; it does not mean newer manual edits were saved. `saved:false` with `saveOutcome:unknown` keeps a renderer write barrier. Use `screenstudio_editor_save_observation` with the returned `saveId` to inspect late fulfillment or rejection separately from the immutable mutation receipt. A missing observation is unknown, including after renderer reload, and never authorizes retry. Late fulfillment reports whether the live content diverged and whether it was marked clean. Save and close rechecks the exact live context and content immediately before closing.

Snapshot, live inspection and preview capture remain available during a pending save; general seek/play and editor writes remain refused. This guard lives in renderer memory and does not survive renderer reloads or cover every direct bridge/filesystem/input writer. Do not treat a renderer restart or SDK timeout as proof that native writing stopped.

Closing with `save:false` never silently drops dirty work. It closes a clean editor, or requires an `expectedFingerprint` from the exact V3 snapshot explicitly authorized for discard; any changed content refuses. The discard check runs again inside the renderer before closing. Never fetch a new snapshot merely to bless unexpected manual edits. All close operations use the write build gate.

Save outcomes include the originating `instanceId` and `startedAtMs` when observed. Pass `expectedInstanceId` to `editor_save_observation` to detect a changed renderer nonce; a mismatch is not proof that prior native work stopped. Native writes are acknowledged only by the tested route's observed void result; unexpected resolved values remain unknown with quarantine retained. Legacy apply retains its checkpoint/results even if the following save call fails. Non-finite serialization remains unsupported and is refused before save dispatch.
