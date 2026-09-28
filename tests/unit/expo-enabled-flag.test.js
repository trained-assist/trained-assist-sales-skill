import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// #1752: sessions and durable plan steps run with cwd = a PROJECT folder; the expo flag
// is profile state and must be found from there too.
describe('isExpoEnabled — profile-level flag', () => {
  const saved = { USER_ID: process.env.USER_ID, AGENT_USERS_DIR: process.env.AGENT_USERS_DIR };
  afterEach(() => { Object.assign(process.env, saved); for (const k of Object.keys(saved)) if (saved[k] === undefined) delete process.env[k]; });

  function load(root, userId) {
    process.env.AGENT_USERS_DIR = root; process.env.USER_ID = userId;
    delete require.cache[require.resolve('../../src/mcp-skills/expo-paths.js')];
    return require('../../src/mcp-skills/expo-paths.js');
  }

  it('finds the flag in the profile root when cwd is a project folder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-flag-'));
    const profile = path.join(root, 'u1');
    const project = path.join(profile, 'projects', 'expo-x');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(profile, 'contexts', 'expo'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'contexts', 'expo', '.enabled'), '{}');
    const p = load(root, 'u1');
    expect(p.isExpoEnabled(project)).toBe(true);
    expect(p.expoFlagPath(project)).toBe(path.join(profile, 'contexts', 'expo', '.enabled'));
  });

  it('still honours a legacy flag next to cwd, and is false without any flag', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-flag-'));
    const cwd = path.join(root, 'elsewhere');
    fs.mkdirSync(cwd, { recursive: true });
    const p = load(root, 'nobody');
    expect(p.isExpoEnabled(cwd)).toBe(false);
    fs.mkdirSync(path.join(cwd, 'contexts', 'expo'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'contexts', 'expo', '.enabled'), '{}');
    expect(p.isExpoEnabled(cwd)).toBe(true);
  });
});
