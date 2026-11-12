/** What another app on the same machine needs to read Pi's OptChat files: profiles, their memory and who holds each, all without
 * writing anything. Node only, and nothing from Pi at runtime. Only Pi writes a profile, while it holds the profile's lock. */
export { dataHome, listProfiles, memoryDirectory, profileOwner, profilePath, type Owner } from './profiles.ts';
export { fingerprint, readImage } from './store.ts';
export { readMemory, type Memory } from './memory.ts';
