import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSkillTriggerIndex } from '../src/core/skill-trigger-index.ts';

describe('skill-trigger-index symlink support', () => {
  let testTmpDir: string;
  let realSkillDir: string;
  let symlinkTargetDir: string;
  let symlinkSkillDir: string;

  beforeEach(() => {
    // Create temp directory for test
    testTmpDir = join(tmpdir(), `gbrain-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testTmpDir, { recursive: true });

    // Create a real skill directory with triggers
    realSkillDir = join(testTmpDir, 'real-skill');
    mkdirSync(realSkillDir, { recursive: true });
    writeFileSync(join(realSkillDir, 'SKILL.md'), `---
triggers:
  - "test real skill"
  - "real trigger"
---

# Real Skill

This is a real skill for testing.
`);

    // Create a target directory for symlink (outside testTmpDir to test cross-tree symlinks)
    symlinkTargetDir = join(tmpdir(), `gbrain-symlink-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(symlinkTargetDir, { recursive: true });
    writeFileSync(join(symlinkTargetDir, 'SKILL.md'), `---
triggers:
  - "test symlink skill"
  - "symlinked trigger"
---

# Symlinked Skill

This is a symlinked skill for testing.
`);

    // Create symlink in test directory pointing to the target
    symlinkSkillDir = join(testTmpDir, 'symlink-skill');
    symlinkSync(symlinkTargetDir, symlinkSkillDir);
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testTmpDir)) {
      rmSync(testTmpDir, { recursive: true, force: true });
    }
    if (existsSync(symlinkTargetDir)) {
      rmSync(symlinkTargetDir, { recursive: true, force: true });
    }
  });

  test('RED - symlinked skill triggers should be present but are currently missing', () => {
    const triggerIndex = loadSkillTriggerIndex(testTmpDir);
    
    // Real skill should be present (this should work even before fix)
    const realSkillEntries = triggerIndex.filter(entry => entry.skillPath === 'skills/real-skill/SKILL.md');
    expect(realSkillEntries.length).toBeGreaterThan(0);
    
    // Symlinked skill triggers should be present (this FAILS on current code - the bug)
    const symlinkSkillEntries = triggerIndex.filter(entry => entry.skillPath === 'skills/symlink-skill/SKILL.md');
    expect(symlinkSkillEntries.length).toBeGreaterThan(0); // This should FAIL before fix
    expect(symlinkSkillEntries.some(entry => entry.trigger.includes('test symlink skill'))).toBe(true);
  });

  test('symlink pointing to non-directory should be skipped', () => {
    // Create a file to symlink to
    const targetFile = join(tmpdir(), `gbrain-file-target-${Date.now()}.txt`);
    writeFileSync(targetFile, 'not a directory');
    
    const symlinkToFile = join(testTmpDir, 'symlink-to-file');
    symlinkSync(targetFile, symlinkToFile);
    
    const triggerIndex = loadSkillTriggerIndex(testTmpDir);
    const fileSymlinkEntries = triggerIndex.filter(entry => entry.skillPath === 'skills/symlink-to-file/SKILL.md');
    expect(fileSymlinkEntries.length).toBe(0);
    
    // Cleanup
    rmSync(targetFile, { force: true });
  });

  test('broken symlink should not throw and be skipped', () => {
    // Create a symlink to a non-existent target
    const brokenSymlink = join(testTmpDir, 'broken-symlink');
    symlinkSync('/nonexistent/path', brokenSymlink);
    
    // This should not throw
    const triggerIndex = loadSkillTriggerIndex(testTmpDir);
    const brokenSymlinkEntries = triggerIndex.filter(entry => entry.skillPath === 'skills/broken-symlink/SKILL.md');
    expect(brokenSymlinkEntries.length).toBe(0);
  });

  test('symlink to directory outside skills tree should still load', () => {
    // This tests the "trusted-local behavior" mentioned in the plan
    // The symlink we created in beforeEach already tests this (symlinkTargetDir is outside testTmpDir)
    const triggerIndex = loadSkillTriggerIndex(testTmpDir);
    
    const symlinkSkillEntries = triggerIndex.filter(entry => entry.skillPath === 'skills/symlink-skill/SKILL.md');
    // This will pass after the fix - documenting that cross-tree symlinks work
    expect(symlinkSkillEntries.length).toBeGreaterThan(0);
  });
});