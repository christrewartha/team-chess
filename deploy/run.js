'use strict';
// `npm run deploy` entry point: finds a bash (Git Bash on Windows) and runs deploy.sh with it.
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  // Git's own install root, worked out from wherever git.exe lives
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(); // .../mingw64/libexec/git-core
    const root = path.resolve(execPath, '..', '..', '..');
    candidates.push(path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe'));
  } catch (e) { /* git not on PATH */ }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  // deliberately not C:\Windows\System32\bash.exe: that's WSL, which has its own ssh keys and git
  return candidates.find((c) => fs.existsSync(c)) || null;
}

const bash = findBash();
if (!bash) {
  console.error('Could not find Git Bash. Install Git for Windows (https://git-scm.com), or run deploy/deploy.sh from a Git Bash window.');
  process.exit(1);
}
const script = path.join(__dirname, 'deploy.sh').replace(/\\/g, '/');
const r = spawnSync(bash, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
