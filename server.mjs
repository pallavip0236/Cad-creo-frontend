import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const PORT = Number(process.env.CREO_API_PORT || 8787);
const AGENT_ROOT = path.resolve('D:/creo-ai-agent');

const MIME_TYPES = {
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

function normalizeFolderKey(filePath, fallbackName) {
  const normalized = String(filePath || fallbackName || 'file.pdf').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length) return safeBasename(fallbackName || 'file.pdf');
  if (segments.length === 1) return safeBasename(segments[0]);
  return segments.slice(1).join('/');
}

function isPdfName(name) {
  return String(name || '').toLowerCase().endsWith('.pdf');
}

function buildFolderMap(files = []) {
  const map = new Map();
  for (const file of files) {
    const key = normalizeFolderKey(file?.path, file?.name);
    if (!map.has(key)) {
      map.set(key, file);
    }
  }
  return map;
}

async function writeFolderFiles(targetDir, files = []) {
  await ensureDirectory(targetDir);
  await Promise.all(
    files.map(async (file) => {
      if (!file || !file.name || !file.dataUrl) {
        throw new Error('Each uploaded file must include a name and dataUrl.');
      }

      const { buffer } = parseDataUrl(file.dataUrl);
      const relativePath = normalizeFolderKey(file.path, file.name);
      const targetPath = path.join(targetDir, relativePath);
      await ensureDirectory(path.dirname(targetPath));
      await fs.writeFile(targetPath, buffer);
    }),
  );
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function runPythonComparison(referencePath, creoPath) {
  const script = `
import json
import sys
from app.services.pdf_analyzer import run_comparison

ref_path = sys.argv[1]
creo_path = sys.argv[2]

with open(ref_path, "rb") as ref_handle:
    ref_bytes = ref_handle.read()

with open(creo_path, "rb") as creo_handle:
    creo_bytes = creo_handle.read()

result = run_comparison(ref_bytes, creo_bytes)
if result.get("status") == "success":
    for page in result.get("pages", []):
        page.pop("comparison_image", None)

print(json.dumps(result, ensure_ascii=False))
`.trim();

  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', args: ['-3', '-c', script, referencePath, creoPath] },
        { command: 'python', args: ['-c', script, referencePath, creoPath] },
      ]
    : [
        { command: 'python3', args: ['-c', script, referencePath, creoPath] },
        { command: 'python', args: ['-c', script, referencePath, creoPath] },
      ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFile(candidate.command, candidate.args, {
        cwd: AGENT_ROOT,
        maxBuffer: 20 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') {
        break;
      }
    }
  }

  throw lastError || new Error('Failed to launch the comparison engine.');
}

async function compareFolderBatch(referenceFiles = [], creoFiles = [], reportType = 'initial') {
  const referenceMap = buildFolderMap(referenceFiles);
  const creoMap = buildFolderMap(creoFiles);
  const referenceKeys = [...referenceMap.keys()];
  const creoKeys = [...creoMap.keys()];
  const matchedKeys = referenceKeys.filter((key) => creoMap.has(key));
  const missingCreoFiles = referenceKeys.filter((key) => !creoMap.has(key));
  const missingReferenceFiles = creoKeys.filter((key) => !referenceMap.has(key));

  if (!matchedKeys.length) {
    throw new Error('No matching PDF pairs were found between the uploaded folders.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'creo-ui-'));
  const referenceDir = path.join(tempRoot, 'reference');
  const creoDir = path.join(tempRoot, 'creo');
  let pages = [];
  let totalIssues = 0;
  const byType = {};
  let scoreTotal = 0;
  let scoreWeight = 0;

  try {
    await writeFolderFiles(referenceDir, referenceFiles);
    await writeFolderFiles(creoDir, creoFiles);

    for (const key of matchedKeys) {
      const referencePath = path.join(referenceDir, key);
      const creoPath = path.join(creoDir, key);
      const result = await runPythonComparison(referencePath, creoPath);

      if (result?.status !== 'success') {
        throw new Error(result?.message || `Comparison failed for ${key}`);
      }

      const documentPages = Array.isArray(result.pages) ? result.pages : [];
      pages = pages.concat(
        documentPages.map((page) => ({
          ...page,
          document: key,
        })),
      );

      totalIssues += Number(result.summary?.total_issues || 0);
      scoreTotal += Number(result.summary?.overall_score || 0) * Math.max(documentPages.length, 1);
      scoreWeight += Math.max(documentPages.length, 1);

      for (const [type, count] of Object.entries(result.summary?.by_type || {})) {
        byType[type] = (byType[type] || 0) + Number(count || 0);
      }
    }

    const overallScore = scoreWeight ? Math.round(scoreTotal / scoreWeight) : 0;

    return {
      ok: true,
      reportType,
      report: {
        generatedAt: new Date().toISOString(),
        mode: reportType,
        folders: {
          reference: referenceFiles.length,
          creo: creoFiles.length,
          matched: matchedKeys.length,
          missingCreoFiles,
          missingReferenceFiles,
        },
        summary: {
          total_issues: totalIssues,
          by_type: byType,
          page_count: pages.length,
          overall_score: overallScore,
        },
        pages,
      },
      warnings: {
        missingCreoFiles,
        missingReferenceFiles,
      },
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
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

async function handleAnalyze(req, res) {
  try {
    const payload = await readJsonBody(req);
    const referenceFiles = Array.isArray(payload.referenceFiles) ? payload.referenceFiles : [];
    const creoFiles = Array.isArray(payload.creoFiles) ? payload.creoFiles : [];

    if (!referenceFiles.length || !creoFiles.length) {
      sendJson(res, 400, {
        ok: false,
        error: 'Please select both the input folder and the Creo folder before generating the report.',
      });
      return;
    }

    const result = await compareFolderBatch(referenceFiles, creoFiles, 'initial');
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message || 'Analysis failed.',
    });
  }
}

async function handleComparison(req, res) {
  try {
    const payload = await readJsonBody(req);
    const referenceFiles = Array.isArray(payload.referenceFiles) ? payload.referenceFiles : [];
    const creoFiles = Array.isArray(payload.creoFiles) ? payload.creoFiles : [];

    if (!referenceFiles.length || !creoFiles.length) {
      sendJson(res, 400, {
        ok: false,
        error: 'Please select the same input folder and a corrected Creo folder before comparing.',
      });
      return;
    }

    const result = await compareFolderBatch(referenceFiles, creoFiles, 'comparison');
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message || 'Comparison failed.',
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

  if (req.method === 'POST' && url.pathname === '/api/run-comparison') {
    await handleComparison(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, agentRoot: AGENT_ROOT });
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
