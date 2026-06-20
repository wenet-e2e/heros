import fs from 'node:fs';
import path from 'node:path';

const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'MEMORY.md'];

export function ensureAgentBootstrap(dataDir) {
  const sourceDir = path.join(process.cwd(), 'docs', 'agent-bootstrap');
  const targetDir = path.join(dataDir, 'agent-bootstrap');
  fs.mkdirSync(targetDir, { recursive: true });

  const files = [];
  for (const fileName of BOOTSTRAP_FILES) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
    files.push(targetPath);
  }

  return {
    targetDir,
    files,
  };
}

export function readAgentBootstrap(files) {
  return Object.fromEntries(
    files.map((filePath) => [path.basename(filePath), fs.readFileSync(filePath, 'utf8')]),
  );
}
