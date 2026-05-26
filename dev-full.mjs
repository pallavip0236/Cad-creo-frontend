import { spawn } from 'node:child_process';

function pipeOutput(child, label) {
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const handleData = (chunk) => {
      const text = String(chunk);
      if (/listening|local:\s+http:\/\/localhost:8787/i.test(text)) {
        resolved = true;
        cleanup();
        resolve();
      }
    };

    const handleExit = (code) => {
      if (!resolved) {
        cleanup();
        reject(new Error(`API exited before becoming ready (code ${code ?? 'unknown'})`));
      }
    };

    const cleanup = () => {
      child.stdout?.off('data', handleData);
      child.off('exit', handleExit);
    };

    child.stdout?.on('data', handleData);
    child.on('exit', handleExit);
  });
}

const api = spawn('npm', ['run', 'api'], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

pipeOutput(api, 'api');

api.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`[api] exited with code ${code}`);
    process.exitCode = code;
  }
});

const shutdown = () => {
  if (!api.killed) {
    api.kill();
  }
  if (ui && !ui.killed) {
    ui.kill();
  }
  process.exit();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

let ui;

try {
  await waitForListening(api);
  ui = spawn('npm', ['run', 'ui', '--', '--host', '0.0.0.0'], {
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });

  ui.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[ui] exited with code ${code}`);
      process.exitCode = code;
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown();
}
