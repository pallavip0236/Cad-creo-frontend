import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const PORT = Number(process.env.CREO_API_PORT || 8787);
const ANALYZER_ROOT = path.resolve('D:/PDF_Analyzer_V2');
const INPUT_DIR = path.join(ANALYZER_ROOT, 'Input_PDFs');
const REVIEW_DIR = path.join(ANALYZER_ROOT, 'Creo_PDFs');
const OUTPUT_DIR = path.join(ANALYZER_ROOT, 'output');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function ensureDirectory(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function clearDirectory(dir) {
  await ensureDirectory(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const targetPath = path.join(dir, entry.name);
      await fs.rm(targetPath, { recursive: true, force: true });
    }),
  );
}

function safeBasename(filename) {
  const baseName = path.basename(String(filename || 'file.pdf'));
  return baseName.replace(/[/\\?%*:|"<>]/g, '_');
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) {
    throw new Error('Invalid data URL payload.');
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

async function writePayloadFiles(targetDir, files = []) {
  await clearDirectory(targetDir);
  await Promise.all(
    files.map(async (file) => {
      if (!file || !file.name || !file.dataUrl) {
        throw new Error('Each uploaded file must include a name and dataUrl.');
      }

      const { buffer } = parseDataUrl(file.dataUrl);
      const fileName = safeBasename(file.name);
      const targetPath = path.join(targetDir, fileName);
      await fs.writeFile(targetPath, buffer);
    }),
  );
}

async function runAnalyzer() {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', args: ['-3', 'main.py', '--ref', 'Input_PDFs', '--review', 'Creo_PDFs'] },
        { command: 'python', args: ['main.py', '--ref', 'Input_PDFs', '--review', 'Creo_PDFs'] },
      ]
    : [
        { command: 'python3', args: ['main.py', '--ref', 'Input_PDFs', '--review', 'Creo_PDFs'] },
        { command: 'python', args: ['main.py', '--ref', 'Input_PDFs', '--review', 'Creo_PDFs'] },
      ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      await execFile(candidate.command, candidate.args, {
        cwd: ANALYZER_ROOT,
        maxBuffer: 20 * 1024 * 1024,
      });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        break;
      }
    }
  }

  throw lastError || new Error('Failed to launch analyzer.');
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  return fs
    .readFile(filePath)
    .then((content) => {
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    })
    .catch(() => {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end('Not found');
    });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleAnalyze(req, res) {
  try {
    const payload = await readJsonBody(req);
    const referenceFiles = Array.isArray(payload.referenceFiles) ? payload.referenceFiles : [];
    const reviewFiles = Array.isArray(payload.reviewFiles) ? payload.reviewFiles : [];

    if (!referenceFiles.length || !reviewFiles.length) {
      sendJson(res, 400, {
        ok: false,
        error: 'Please select PDF files for both the reference and Creo panels.',
      });
      return;
    }

    await ensureDirectory(ANALYZER_ROOT);
    await writePayloadFiles(INPUT_DIR, referenceFiles);
    await writePayloadFiles(REVIEW_DIR, reviewFiles);
    await runAnalyzer();

    sendJson(res, 200, {
      ok: true,
      reportUrl: `/report.html?ts=${Date.now()}`,
      reportPath: path.join(OUTPUT_DIR, 'report.html'),
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message || 'Analyzer execution failed.',
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    await handleAnalyze(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/report.html') {
    await sendFile(res, path.join(OUTPUT_DIR, 'report.html'));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/comparisons/')) {
    const fileName = path.basename(url.pathname);
    await sendFile(res, path.join(OUTPUT_DIR, 'comparisons', fileName));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Creo analyzer API listening on http://localhost:${PORT}`);
});
