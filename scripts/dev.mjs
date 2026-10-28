import { get } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const projectRoot = process.cwd();
const frontendRoot = resolve(projectRoot, 'src/frontend');
const children = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 5_000).unref();
}

function watch(child) {
  child.on('error', (error) => {
    console.error(`开发服务启动失败：${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`开发服务已退出（${signal ?? code ?? 'unknown'}），正在停止其余服务。`);
      stop(code ?? 1);
    }
  });
}

function backendAvailable() {
  return new Promise((resolve) => {
    const request = get('http://127.0.0.1:9200/healthz', (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(800, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForBackend() {
  const deadline = Date.now() + 30_000;
  while (!stopping && Date.now() < deadline) {
    if (await backendAvailable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const backend = spawn(
  'conda',
  [
    'run',
    '--no-capture-output',
    '-n',
    'paper',
    'uvicorn',
    'src.backend.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    '9200',
    '--reload',
    '--reload-dir',
    'src/backend',
  ],
  { cwd: projectRoot, stdio: 'inherit' },
);
children.push(backend);
watch(backend);

async function startFrontend() {
  if (!(await waitForBackend())) {
    if (!stopping) {
      console.error('后端未能在 30 秒内就绪，已取消启动前端。');
      stop(1);
    }
    return;
  }

  const frontend = spawn('npm', ['run', 'dev'], {
    cwd: frontendRoot,
    stdio: 'inherit',
  });
  children.push(frontend);
  watch(frontend);
}

void startFrontend();

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
