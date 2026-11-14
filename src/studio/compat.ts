// Everything tied to one Screen Studio build. A new app version starts here.

export const APP_BUILD = "4.1.0-5005";
export const PROJECT_SCHEMA = "4.0.0";

// Seeking changes this serialized view preference without creating an edit.
export const PROJECT_VIEW_DATA_KEYS = ["last-playback-position-source-time-ms"] as const;

/** The tested project.updateProject route acknowledges a successful write with void. */
export function projectSaveAcknowledged(value: unknown): boolean {
  return value === undefined;
}

/** Bundle chunk holding the editor's transcript model, and its minified export. */
export const TRANSCRIPT_CHUNK = "B0echNca.js";
export const TRANSCRIPT_EXPORT = "b";

/** Bundle chunk holding the native Swift service client, and its minified export. */
export const NATIVE_CLIENT_CHUNK = "DLnk-cLt.js";
export const NATIVE_CLIENT_EXPORT = "t";

/** Bundle chunk holding the recording input discovery store, and its minified export. */
export const INPUTS_CHUNK = "CVCogM-Y2.js";
export const INPUTS_EXPORT = "t";

export const editorWindowTitle = (projectName: string) => `Project - ${projectName}`;

export const capabilities = {
  app: "Screen Studio",
  testedVersion: APP_BUILD,
  schema: PROJECT_SCHEMA,
  transport: "local stdio",
  features: {
    recording: true,
    windowCapture: true,
    pauseResume: true,
    markers: true,
    config: true,
    trimSpeed: true,
    screenAndLoupeZoom: true,
    liveEditorEditing: true,
    editorPreviewFrames: true,
    recordingAnalysis: true,
    editPlanning: true,
    pacingCheck: true,
    localExport: true,
    renderedPreview: true,
    desktopInput: true,
    transcriptRead: true,
    transcriptGeneration: true,
    transcriptEditing: true,
    voiceoverGeneration: false,
    backgroundMusic: true,
    presets: true,
    maskEditing: true,
    layoutTimelineEditing: true,
    fitToLength: true,
    recordingMarkers: true,
    directorsNotes: true,
    recipes: true,
    cameraDirector: true,
    brandKits: true,
    narrationCaptions: true,
    voiceLines: true,
    sensitiveTextRedaction: true,
    customMediaAssets: true,
    colorGradingLuts: true,
    externalDeviceCapture: true,
    proresExport: true,
    recentProjects: true,
    recordingRecovery: true,
    videoImport: true,
    windowManagement: true,
    exportVariants: true,
    seamlessLoops: true,
    contactSheet: true,
  },
  /** Tools beyond the app's own commands. */
  tools: [
    "screenstudio_recipes",
    "screenstudio_plan_layouts",
    "screenstudio_brand",
    "screenstudio_voice_lines",
    "screenstudio_find_sensitive",
    "screenstudio_export_variants",
    "screenstudio_loop",
    "screenstudio_contact_sheet",
  ],
  notes: [
    "Unofficial integration. Screen Studio updates may change internal interfaces.",
    "Caption styling, webcam processing/LUTs, cursor rotation and layout defaults are available as config settings.",
    "Screen Studio AI and recorded voiceover tracks are disabled in this app build; narration uses the background audio track.",
    "Edits go through the open editor window: they appear live, use the app's undo history and save like Cmd+S.",
    "Exports support MP4 (H.264, HEVC, or both), ProRes (.mov), and GIF via the local QA render destination without a save dialog, then move finished file(s) to the requested destination. No sharing or upload.",
  ],
};
