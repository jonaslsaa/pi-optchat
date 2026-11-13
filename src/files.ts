/** What another app on the same machine needs for Pi's OptChat profiles, without Pi: read profiles, their memory, runs and who holds
 * each, create a profile, change its settings and instructions, and talk to its subagents through the Pi that owns it. Node only,
 * and nothing from Pi at runtime. Only the holder of a profile's lock writes it, except AGENTS.md, which Pi reads fresh each turn. */
export { createProfile, dataHome, listProfiles, memoryDirectory, profileOwner, profilePath, type Owner } from './profiles.ts';
export { defaults, loadConfig, readInstructions, saveInstructions, THINKING, type ConfigPatch, type ModelChoice, type ProfileConfig } from './profiles.ts';
export { percent, SETTING_KEYS, SETTINGS } from './settings.ts';
export { fingerprint, readImage } from './store.ts';
export { readMemory, type Memory } from './memory.ts';
export { readRuns, type RunInfo, type RunState } from './run-record.ts';
export { attachAgent, updateConfig, type AttachedAgent, type LiveState, type LiveTool, type WindowEvent, type WindowMessage } from './window-client.ts';
/** What Pi itself uses to hold a profile and serve its agents, for an app's stand-in for Pi in its tests: the profile's lock (taken
 * with the description `profileOwner` reads back), the socket path, which is a named pipe on Windows, and the socket's framing. */
export { describeOwner, lockProfile, profileSocket, removeStaleSocket } from './profiles.ts';
export { wire } from './window-client.ts';
