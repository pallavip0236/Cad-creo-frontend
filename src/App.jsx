import { useEffect, useMemo, useRef, useState } from 'react';

const nativeFormats = [
  { label: 'Native CAD', value: 'native' },
  { label: 'STEP', value: 'step' },
  { label: 'IGES', value: 'iges' },
  { label: 'Parasolid', value: 'parasolid' },
  { label: 'JT', value: 'jt' },
];

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value.toFixed(value >= 10 || power === 0 ? 0 : 1)} ${units[power]}`;
}

function formatTimestamp(date) {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

function isPdfFile(file) {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.pdf') || type === 'application/pdf';
}

function folderLabel(files) {
  if (!files.length) return '';
  const firstPath = files[0].webkitRelativePath || files[0].name;
  const segments = String(firstPath).replace(/\\/g, '/').split('/').filter(Boolean);
  const rootFolder = segments.length > 1 ? segments[0] : files[0].name.replace(/\.[^.]+$/, '');
  const suffix = files.length === 1 ? '1 PDF file' : `${files.length} PDF files`;
  return `${rootFolder} · ${suffix}`;
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function buildFolderPayload(files) {
  return Promise.all(
    files.map(async (entry) => ({
      name: entry.name, path: entry.path, size: entry.size, type: entry.type,
      dataUrl: await fileToDataUrl(entry.sourceFile),
    })),
  );
}

function stringifyReport(report) { return JSON.stringify(report, null, 2); }

const AUDIT_CATEGORIES = [
  'Drawing Layout','Views & Geometry','Dimensions & Tolerances','Notes & Annotations',
  'Title Block','Revision History','BOM / Tables','Symbols & Standards',
  'Styling & Layers','Scale & Proportion','Visual Quality','Conversion Integrity','Compliance Rules',
];

function issueTypeToCategory(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('geometry') || t.includes('view') || t.includes('visual_discrepancy') || t.includes('geometric')) return 'Views & Geometry';
  if (t.includes('dimension') || t.includes('tolerance')) return 'Dimensions & Tolerances';
  if (t.includes('annotation') || t.includes('note') || t.includes('missing') || t.includes('text_misplace')) return 'Notes & Annotations';
  if (t.includes('title') || t.includes('block')) return 'Title Block';
  if (t.includes('revision') || t.includes('history')) return 'Revision History';
  if (t.includes('bom') || t.includes('table')) return 'BOM / Tables';
  if (t.includes('symbol') || t.includes('standard')) return 'Symbols & Standards';
  if (t.includes('style') || t.includes('layer')) return 'Styling & Layers';
  if (t.includes('scale') || t.includes('proportion')) return 'Scale & Proportion';
  if (t.includes('visual') || t.includes('quality') || t.includes('overlap') || t.includes('text_overlap')) return 'Visual Quality';
  if (t.includes('conversion') || t.includes('integrity')) return 'Conversion Integrity';
  if (t.includes('compliance') || t.includes('rule')) return 'Compliance Rules';
  if (t.includes('layout')) return 'Drawing Layout';
  return 'Views & Geometry';
}

function buildPageCategories(page) {
  const cats = {};
  for (const cat of AUDIT_CATEGORIES) cats[cat] = { pass: true, issues: [] };
  const issueList = Array.isArray(page.issues) ? page.issues : [];
  const categoryObj = (page.categories && typeof page.categories === 'object') ? page.categories : {};
  for (const issue of issueList) {
    const type = issue.type || issue.issue_type || issue.category || '';
    const desc = issue.description || issue.message || issue.detail || String(issue);
    const cat = issueTypeToCategory(type);
    cats[cat].pass = false;
    cats[cat].issues.push(desc);
  }
  for (const [key, val] of Object.entries(categoryObj)) {
    const catName = AUDIT_CATEGORIES.find(c => c.toLowerCase() === key.toLowerCase()) || key;
    if (!cats[catName]) cats[catName] = { pass: true, issues: [] };
    if (val && (val.pass === false || val.status === 'FAIL' || (Array.isArray(val.issues) && val.issues.length))) {
      cats[catName].pass = false;
      if (Array.isArray(val.issues)) cats[catName].issues.push(...val.issues.map(i => typeof i === 'string' ? i : i.description || JSON.stringify(i)));
    }
  }
  return cats;
}

function pageSeverity(page) {
  const issues = Array.isArray(page.issues) ? page.issues : [];
  let high = 0, medium = 0, low = 0;
  for (const issue of issues) {
    const sev = String(issue.severity || issue.level || '').toLowerCase();
    if (sev === 'high' || sev === 'critical') high++;
    else if (sev === 'low') low++;
    else medium++;
  }
  const total = Number(page.issue_count ?? page.issueCount ?? page.issues?.length ?? page.issues_count ?? 0);
  if (high + medium + low === 0 && total > 0) { high = Math.round(total * 0.3); medium = total - high; }
  return { high, medium, low };
}

function buildAuditMatrix(pages) {
  const matrix = {};
  for (const cat of AUDIT_CATEGORIES) matrix[cat] = { failedPages: new Set() };
  pages.forEach((page, idx) => {
    const cats = buildPageCategories(page);
    for (const [cat, data] of Object.entries(cats)) {
      if (!data.pass) matrix[cat].failedPages.add(idx);
    }
  });
  return matrix;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function normalizeReportKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/\.[^.]+$/, '')
    .toLowerCase() || '';
}

function addDrawingAlias(map, key, url) {
  const raw = String(key || '');
  const normalized = raw.replace(/\\/g, '/').toLowerCase();
  const base = normalizeReportKey(raw);
  if (raw) map.set(raw, url);
  if (normalized) map.set(normalized, url);
  if (base) map.set(base, url);
}

// ── REPORT HTML BUILDER (light theme, drawings embedded, direct PDF download via jsPDF) ──
function buildReportHtml(report, title, comparisonReport = null, drawingDataUrls = {}, autoDownload = false) {
  const generatedAt = report?.generatedAt ? formatTimestamp(new Date(report.generatedAt)) : '—';
  const summary = report?.summary || {};
  const folders = report?.folders || {};
  const pages = Array.isArray(report?.pages) ? report.pages : [];
  const isComparison = !!comparisonReport;
  const totalIssues = summary.total_issues ?? pages.reduce((acc, p) => acc + Number(p.issue_count ?? p.issueCount ?? p.issues?.length ?? 0), 0);
  let totalHigh = 0, totalMedium = 0, totalLow = 0;
  for (const page of pages) { const { high, medium, low } = pageSeverity(page); totalHigh += high; totalMedium += medium; totalLow += low; }
  if (totalHigh + totalMedium + totalLow === 0 && totalIssues > 0) { totalHigh = Math.round(totalIssues * 0.35); totalMedium = totalIssues - totalHigh; }
  const cleanPages = pages.filter(p => Number(p.issue_count ?? p.issueCount ?? p.issues?.length ?? 0) === 0).length;
  const pagesWithIssues = pages.length - cleanPages;
  const overallScore = summary.overall_score ?? '—';
  const matrix = buildAuditMatrix(pages);

  const matrixRows = AUDIT_CATEGORIES.map(cat => {
    const failed = matrix[cat]?.failedPages?.size ?? 0;
    const pass = failed === 0;
    return `<tr><td class="cat-name">${esc(cat)}</td><td><span class="pill ${pass?'pill-pass':'pill-fail'}">${pass?'PASS':'FAIL'}</span></td><td class="muted-td">${failed} page(s) failed</td></tr>`;
  }).join('');

  let comparisonSection = '';
  if (comparisonReport) {
    const compPages = Array.isArray(comparisonReport?.pages) ? comparisonReport.pages : [];
    const compSummary = comparisonReport?.summary || {};
    const compIssues = compSummary.total_issues ?? compPages.reduce((acc, p) => acc + Number(p.issue_count ?? p.issueCount ?? p.issues?.length ?? 0), 0);
    const compScore = compSummary.overall_score ?? '—';
    const issueDelta = totalIssues - compIssues;
    const initialMap = {};
    for (const p of pages) { const k = p.document||p.file||p.path||'Unknown'; initialMap[k]=(initialMap[k]||0)+Number(p.issue_count??p.issueCount??p.issues?.length??0); }
    const compMap = {};
    for (const p of compPages) { const k = p.document||p.file||p.path||'Unknown'; compMap[k]=(compMap[k]||0)+Number(p.issue_count??p.issueCount??p.issues?.length??0); }
    const allDocs = Array.from(new Set([...Object.keys(initialMap),...Object.keys(compMap)])).sort();
    const fileRows = allDocs.map(doc => {
      const ini = initialMap[doc]??0, cor = compMap[doc]??0, delta = ini-cor;
      const deltaStr = delta>0?`<span style="color:#16a34a;font-weight:700">▼ ${delta} fixed</span>`:delta<0?`<span style="color:#dc2626;font-weight:700">▲ ${Math.abs(delta)}</span>`:`<span style="color:#64748b">—</span>`;
      return `<tr><td class="cat-name">${esc(doc)}</td><td style="color:#dc2626;font-weight:700;text-align:center">${ini}</td><td style="color:#16a34a;font-weight:700;text-align:center">${cor}</td><td style="text-align:center">${deltaStr}</td></tr>`;
    }).join('');
    comparisonSection = `
    <div class="section-block">
      <h2 class="section-heading">⇄ Initial vs Corrected Comparison</h2>
      <div class="compare-hero">
        <div class="compare-card compare-initial">
          <div class="compare-label">Initial Run</div>
          <div class="compare-score" style="color:#dc2626">${overallScore}</div>
          <div class="compare-score-label">Overall Score</div>
          <div class="compare-issues"><span style="color:#dc2626;font-weight:700">${totalIssues}</span> issues flagged</div>
        </div>
        <div class="compare-arrow">→</div>
        <div class="compare-card compare-corrected">
          <div class="compare-label">Corrected Run</div>
          <div class="compare-score" style="color:#16a34a">${compScore}</div>
          <div class="compare-score-label">Overall Score</div>
          <div class="compare-issues"><span style="color:#16a34a;font-weight:700">${compIssues}</span> issues remaining</div>
        </div>
        <div class="compare-delta-block">
          <div class="compare-delta-num">${issueDelta>0?'-'+issueDelta:issueDelta}</div>
          <div class="compare-delta-label">Issues ${issueDelta>0?'Resolved':issueDelta<0?'Added':'No Change'}</div>
        </div>
      </div>
      <div class="matrix-card" style="margin-top:20px">
        <table><thead><tr><th>File</th><th style="text-align:center">Initial Issues</th><th style="text-align:center">Corrected Issues</th><th style="text-align:center">Delta</th></tr></thead>
        <tbody>${fileRows}</tbody></table>
      </div>
    </div>`;
  }

  const pageBreakdowns = pages.map((page, idx) => {
    const docName = page.document||page.file||page.path||`Page ${idx+1}`;
    const pageNum = page.page_number??page.pageNumber??page.page??1;
    const issueCount = Number(page.issue_count??page.issueCount??page.issues?.length??page.issues_count??0);
    const isFail = issueCount > 0;
    const cats = buildPageCategories(page);
    // Try to match drawing by filename - try multiple matching strategies
    const docKey = normalizeReportKey(docName);
    const docPathKey = String(docName || '').replace(/\\/g, '/').toLowerCase();
    let drawingImg = drawingDataUrls.get?.(docName)
      || drawingDataUrls.get?.(docPathKey)
      || drawingDataUrls.get?.(docKey)
      || null;

    if (!drawingImg) {
      for (const [key, url] of drawingDataUrls.entries?.() || []) {
        const keyString = String(key || '').toLowerCase();
        const keyBase = normalizeReportKey(keyString);
        if (keyString === docPathKey || keyBase === docKey || keyString.includes(docKey) || docKey.includes(keyBase)) {
          drawingImg = url;
          break;
        }
      }
    }
    const catCards = AUDIT_CATEGORIES.map(cat => {
      const data = cats[cat]||{pass:true,issues:[]};
      const hasFail = !data.pass;
      return `<div class="cat-card ${hasFail?'cat-fail':'cat-pass'}">
        <div class="cat-card-header"><span class="cat-card-name">${esc(cat)}</span><span class="pill ${hasFail?'pill-fail':'pill-pass'} pill-sm">${hasFail?'FAIL':'PASS'}</span></div>
        ${hasFail&&data.issues.length?`<ul class="issue-list">${data.issues.slice(0,8).map(i=>`<li>${esc(i)}</li>`).join('')}${data.issues.length>8?`<li class="more-link">+${data.issues.length-8} more issues</li>`:''}</ul>`:''}
      </div>`;
    }).join('');
    const failedCatNames = AUDIT_CATEGORIES.filter(cat=>!(cats[cat]?.pass??true));
    return `
      <div class="page-section">
        <div class="page-header">
          <span class="page-filename">${esc(docName)} — Page ${pageNum}</span>
          <span class="page-status ${isFail?'page-fail':'page-pass'}">${isFail?`FAIL – ${issueCount} ISSUE(S)`:'PASS – NO ISSUES'}</span>
        </div>
        ${isFail?`<p class="page-summary-line">Page ${pageNum} has <strong>${issueCount}</strong> identified discrepanc${issueCount===1?'y':'ies'}.${failedCatNames.length?` Failed: <em>${failedCatNames.join(', ')}</em>`:''}</p>`:'<p class="page-summary-line">No issues detected on this page.</p>'}
        ${drawingImg?`<div class="drawing-preview"><div class="drawing-label">📐 Drawing Preview — ${esc(docName)}</div><img src="${drawingImg}" alt="Drawing ${esc(docName)}" class="drawing-img" onerror="this.style.display='none'" /></div>`:``}
        <h3 class="section-subheading">Audit Categories Breakdown</h3>
        <div class="cat-grid">${catCards}</div>
      </div>`;
  }).join('');

  // Serialise drawingDataUrls for the in-page jsPDF download
  const drawingsJson = JSON.stringify([...drawingDataUrls.entries()]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f8f9fc;--surface:#fff;--surface2:#f1f5f9;--border:#e2e8f0;--text:#0f172a;--text2:#334155;--muted:#64748b;--pass:#16a34a;--pass-bg:#f0fdf4;--pass-border:#bbf7d0;--fail:#dc2626;--fail-bg:#fef2f2;--fail-border:#fecaca;--accent:#4f46e5;--radius:12px}
body{font-family:'DM Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;font-size:14px}
.report-wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}
.top-bar{display:flex;justify-content:flex-end;margin-bottom:20px;gap:10px;align-items:center;min-height:44px}
.btn-dl{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 22px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(79,70,229,.25);transition:background .15s;white-space:nowrap}
.btn-dl:hover{background:#4338ca}
.btn-dl:disabled{opacity:.6;cursor:not-allowed}
.dl-progress{display:none;font-size:12px;color:var(--muted);align-items:center;gap:6px;min-width:140px;white-space:nowrap}
.spinner-sm{width:14px;height:14px;border:2px solid #e2e8f0;border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.report-hero{background:linear-gradient(135deg,#eef2ff,#f0f9ff 60%,#faf5ff);border:1px solid var(--border);border-radius:20px;padding:36px 40px;margin-bottom:28px;position:relative;overflow:hidden}
.report-hero::before{content:'';position:absolute;top:-40px;right:-40px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(79,70,229,.08),transparent 70%)}
.hero-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;font-weight:700}
.hero-title{font-family:'DM Serif Display',serif;font-size:clamp(1.6rem,3vw,2.4rem);line-height:1.15;margin-bottom:10px}
.hero-sub{color:var(--muted);font-size:13px;margin-bottom:14px}
.hero-meta{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--muted)}
.hero-meta strong{color:var(--text)}
.issues-banner{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:8px 16px;border-radius:99px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-weight:600;font-size:13px}
.severity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.sev-tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 16px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.05)}
.sev-num{font-size:2.4rem;font-weight:700;font-family:'JetBrains Mono',monospace;line-height:1;margin-bottom:6px}
.sev-label{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
.section-heading{font-family:'DM Serif Display',serif;font-size:1.2rem;font-weight:400;color:var(--text);margin-bottom:14px;padding-left:12px;border-left:3px solid var(--accent)}
.section-subheading{font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.1em;margin:18px 0 10px}
.section-block{margin-bottom:36px}
.compare-hero{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:16px}
.compare-card{flex:1;min-width:140px;border-radius:12px;padding:20px 16px;text-align:center}
.compare-initial{background:#fef2f2;border:1px solid #fecaca}
.compare-corrected{background:#f0fdf4;border:1px solid #bbf7d0}
.compare-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px}
.compare-score{font-family:'JetBrains Mono',monospace;font-size:2.6rem;font-weight:700;line-height:1}
.compare-score-label{font-size:12px;color:var(--muted);margin:4px 0}
.compare-issues{font-size:13px;font-weight:600;color:var(--text2)}
.compare-arrow{font-size:1.8rem;color:#cbd5e1;flex-shrink:0}
.compare-delta-block{background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;padding:18px 24px;text-align:center}
.compare-delta-num{font-family:'JetBrains Mono',monospace;font-size:2.2rem;font-weight:700;color:#4f46e5}
.compare-delta-label{font-size:11px;font-weight:600;color:#6366f1;text-transform:uppercase;letter-spacing:.1em;margin-top:4px}
.matrix-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:36px}
.matrix-card table{width:100%;border-collapse:collapse}
.matrix-card thead tr{background:var(--surface2)}
.matrix-card th{padding:11px 18px;text-align:left;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700}
.matrix-card td{padding:12px 18px;border-top:1px solid var(--border);vertical-align:middle}
.cat-name{font-weight:600;color:var(--text)}
.muted-td{color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;justify-content:center;padding:3px 11px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pill-pass{background:var(--pass-bg);color:var(--pass);border:1px solid var(--pass-border)}
.pill-fail{background:var(--fail-bg);color:var(--fail);border:1px solid var(--fail-border)}
.pill-sm{font-size:10px;padding:2px 8px}
.page-section{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px 22px 18px;margin-bottom:20px}
.page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.page-filename{font-size:.95rem;font-weight:700;color:var(--accent);font-family:'JetBrains Mono',monospace}
.page-status{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:5px 13px;border-radius:99px;white-space:nowrap}
.page-fail{background:var(--fail-bg);color:var(--fail);border:1px solid var(--fail-border)}
.page-pass{background:var(--pass-bg);color:var(--pass);border:1px solid var(--pass-border)}
.page-summary-line{color:var(--muted);font-size:13px;font-style:italic}
.page-summary-line strong{color:var(--text);font-style:normal}
.drawing-preview{margin:16px 0 4px;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface2)}
.drawing-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:7px 13px;border-bottom:1px solid var(--border);background:#f8fafc}
.drawing-img{width:100%;max-height:500px;object-fit:contain;display:block;background:#fff;padding:8px}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:9px;margin-top:4px}
.cat-card{border-radius:9px;padding:13px 15px}
.cat-pass{background:#f0fdf4;border:1px solid #d1fae5;border-left:4px solid var(--pass)}
.cat-fail{background:var(--fail-bg);border:1px solid var(--fail-border);border-left:4px solid var(--fail)}
.cat-card-header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px}
.cat-card-name{font-weight:600;font-size:12px;color:var(--text)}
.issue-list{list-style:none;display:grid;gap:3px;padding:0}
.issue-list li{font-size:11px;color:var(--muted);padding-left:12px;position:relative;line-height:1.4}
.issue-list li::before{content:'▪';position:absolute;left:0;color:rgba(220,38,38,.5)}
.more-link{color:var(--accent)!important;font-style:italic}
.report-footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--border);color:var(--muted);font-size:12px;text-align:center}
@media(max-width:640px){.report-wrap{padding:16px 12px 60px}.severity-grid{grid-template-columns:repeat(2,1fr)}.cat-grid{grid-template-columns:1fr}.compare-hero{flex-direction:column}}
@media print{.top-bar{display:none!important}body{background:#fff!important}}
</style>
</head>
<body>
<div class="report-wrap" id="report-content">
  <div class="top-bar">
    <span class="dl-progress" id="dl-progress"><span class="spinner-sm"></span> Generating PDF…</span>
    <button class="btn-dl" id="dl-btn" onclick="downloadPdf()">⬇ Download PDF</button>
  </div>

  <div class="report-hero">
    <p class="hero-eyebrow">🔍 ${isComparison?'Comparison Report':'Compliance Report'}</p>
    <h1 class="hero-title">Engineering Drawing QA Compliance Report</h1>
    <p class="hero-sub">Automated visual &amp; text compliance audit between design source drawings and Creo review drawings.</p>
    <div class="hero-meta">
      <span>📅 Generated: <strong>${esc(generatedAt)}</strong></span>
      <span>|</span><span>📄 Pages: <strong>${pages.length}</strong></span>
      <span>|</span><span>🏆 Score: <strong>${overallScore}</strong></span>
      ${folders.reference?`<span>|</span><span>Ref PDFs: <strong>${folders.reference}</strong></span>`:''}
    </div>
    <div class="issues-banner">⚠ Total Issues Flagged: <strong>${totalIssues}</strong></div>
  </div>

  <div class="severity-grid">
    <div class="sev-tile"><div class="sev-num" style="color:#4f46e5">${overallScore}</div><div class="sev-label">Overall Score</div></div>
    <div class="sev-tile"><div class="sev-num" style="color:#dc2626">${totalHigh}</div><div class="sev-label">High Severity</div></div>
    <div class="sev-tile"><div class="sev-num" style="color:#d97706">${totalMedium}</div><div class="sev-label">Medium Severity</div></div>
    <div class="sev-tile"><div class="sev-num" style="color:#2563eb">${totalLow}</div><div class="sev-label">Low Severity</div></div>
    <div class="sev-tile"><div class="sev-num" style="color:#16a34a">${cleanPages}</div><div class="sev-label">Clean Pages</div></div>
    <div class="sev-tile"><div class="sev-num" style="color:#dc2626">${pagesWithIssues}</div><div class="sev-label">Pages w/ Issues</div></div>
  </div>

  ${comparisonSection}

  <div class="section-block">
    <h2 class="section-heading">Compliance Audit Matrix (${AUDIT_CATEGORIES.length} Categories)</h2>
    <div class="matrix-card">
      <table><thead><tr><th>Audit Category</th><th>Status</th><th>Failures</th></tr></thead>
      <tbody>${matrixRows}</tbody></table>
    </div>
  </div>

  ${pages.length?`<div class="section-block"><h2 class="section-heading">Page Breakdown Analysis</h2>${pageBreakdowns}</div>`:''}

  <div class="report-footer"><p>Report generated: ${esc(generatedAt)} · ${esc(title)}</p></div>
</div>

<script>
// Embed drawing data so PDF download can use them
const _drawings = new Map(${drawingsJson});
const AUTO_DOWNLOAD = ${autoDownload ? 'true' : 'false'};

function waitForPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function waitForImages(root) {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(img => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(resolve => {
      img.onload = img.onerror = () => resolve();
    });
  }));
}

async function downloadPdf() {
  const btn = document.getElementById('dl-btn');
  const prog = document.getElementById('dl-progress');
  prog.style.display = 'flex';
  let clone = null;
  try {
    const { jsPDF } = window.jspdf;
    const liveContent = document.getElementById('report-content');
    clone = liveContent.cloneNode(true);
    const topBar = clone.querySelector('.top-bar');
    if (topBar) topBar.remove();
    clone.style.position = 'fixed';
    clone.style.left = '-10000px';
    clone.style.top = '0';
    clone.style.width = liveContent.offsetWidth + 'px';
    clone.style.background = '#f8f9fc';
    document.body.appendChild(clone);
    await waitForImages(clone);
    await waitForPaint();
    const canvas = await html2canvas(clone, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#f8f9fc',
      logging: false,
    });
    document.body.removeChild(clone);
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pdfW = pdf.internal.pageSize.getWidth();
    const pdfH = pdf.internal.pageSize.getHeight();
    const ratio = canvas.width / canvas.height;
    const imgW = pdfW;
    const imgH = imgW / ratio;
    let posY = 0;
    let remaining = imgH;
    let firstPage = true;
    while (remaining > 0) {
      if (!firstPage) pdf.addPage();
      const sliceH = Math.min(pdfH, remaining);
      const srcY = posY * (canvas.height / imgH);
      const srcH = sliceH * (canvas.height / imgH);
      // Crop canvas slice
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = srcH;
      const ctx = sliceCanvas.getContext('2d');
      ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
      const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(sliceData, 'JPEG', 0, 0, imgW, sliceH);
      posY += sliceH;
      remaining -= sliceH;
      firstPage = false;
    }
    pdf.save('${title.replace(/'/g,"\\'")}' + '.pdf');
    if (AUTO_DOWNLOAD) {
      setTimeout(() => window.close(), 1000);
    }
  } catch(e) {
    alert('PDF generation failed: ' + e.message);
  } finally {
    if (clone?.parentNode) clone.parentNode.removeChild(clone);
    prog.style.display = 'none';
  }
}
if (AUTO_DOWNLOAD) {
  window.addEventListener('load', () => {
    setTimeout(() => downloadPdf(), 250);
  });
}
<\/script>
</body>
</html>`;
}

// ── LOADING SPINNER ──
function LoadingSpinner({ label }) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,padding:'20px 0'}}>
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{animation:'spin .9s linear infinite'}}>
        <circle cx="22" cy="22" r="18" stroke="#e2e8f0" strokeWidth="4"/>
        <path d="M40 22a18 18 0 0 0-18-18" stroke="#6366f1" strokeWidth="4" strokeLinecap="round"/>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </svg>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{label}</div>
        <div style={{fontSize:11,color:'#94a3b8',marginTop:2}}>Analyzing drawings…</div>
      </div>
    </div>
  );
}

// ── MAIN APP ──
export default function App() {
  const [nativeFormat, setNativeFormat] = useState(nativeFormats[0].value);
  const [referenceFiles, setReferenceFiles] = useState([]);
  const [initialCreoFiles, setInitialCreoFiles] = useState([]);
  const [correctedCreoFiles, setCorrectedCreoFiles] = useState([]);
  const [referenceLabel, setReferenceLabel] = useState('');
  const [initialCreoLabel, setInitialCreoLabel] = useState('');
  const [correctedCreoLabel, setCorrectedCreoLabel] = useState('');
  const [initialReport, setInitialReport] = useState(null);
  const [comparisonReport, setComparisonReport] = useState(null);
  const [generatedAt, setGeneratedAt] = useState('');
  const [comparisonGeneratedAt, setComparisonGeneratedAt] = useState('');
  const [reportStatus, setReportStatus] = useState('Waiting for folder selections');
  const [reportError, setReportError] = useState('');
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [alertTitle, setAlertTitle] = useState('Folder selection');
  const [alertOpen, setAlertOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingComparison, setIsGeneratingComparison] = useState(false);
  const referenceFolderInputRef = useRef(null);
  const initialCreoFolderInputRef = useRef(null);
  const correctedCreoFolderInputRef = useRef(null);
  const formatMenuRef = useRef(null);

  const selectedFormatLabel = nativeFormats.find(i => i.value === nativeFormat)?.label ?? nativeFormat;

  const summary = useMemo(() => {
    const allFiles = [...referenceFiles, ...initialCreoFiles, ...correctedCreoFiles];
    return {
      referenceCount: referenceFiles.length,
      initialCreoCount: initialCreoFiles.length,
      correctedCreoCount: correctedCreoFiles.length,
      size: formatBytes(allFiles.reduce((acc, f) => acc + f.size, 0)),
    };
  }, [referenceFiles, initialCreoFiles, correctedCreoFiles]);

  const outputStatus = reportError ? reportError
    : comparisonReport ? 'Comparison report ready'
    : initialReport ? 'Initial report ready'
    : reportStatus;

  useEffect(() => {
    const fn = e => { if (formatMenuRef.current && !formatMenuRef.current.contains(e.target)) setFormatMenuOpen(false); };
    window.addEventListener('pointerdown', fn);
    return () => window.removeEventListener('pointerdown', fn);
  }, []);

  const openAlert = (msg, ttl='Folder selection') => { setAlertMessage(msg); setAlertTitle(ttl); setAlertOpen(true); };
  const closeAlert = () => { setAlertOpen(false); };

  const toFolderFileEntries = files => files.map(f => ({ sourceFile:f, name:f.name, path:f.webkitRelativePath||f.name, size:f.size, type:f.type||'application/pdf' }));

  const resetInitial = () => { setInitialReport(null); setComparisonReport(null); setGeneratedAt(''); setComparisonGeneratedAt(''); setReportError(''); };
  const resetComparison = () => { setComparisonReport(null); setComparisonGeneratedAt(''); setReportError(''); };

  const handleFolderSelection = (event, setFiles, setLabel, onSuccess, onInvalid) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) { event.target.value = ''; return; }
    if (files.find(f => !isPdfFile(f))) {
      setFiles([]); setLabel(''); onInvalid?.();
      openAlert('Only PDF files are allowed.'); event.target.value = ''; return;
    }
    setFiles(toFolderFileEntries(files)); setLabel(folderLabel(files)); onSuccess?.();
    event.target.value = '';
  };

  const handleReferenceFolder = e => handleFolderSelection(e, setReferenceFiles, setReferenceLabel, () => { resetInitial(); setReportStatus('Input folder selected'); }, resetInitial);
  const handleInitialCreoFolder = e => handleFolderSelection(e, setInitialCreoFiles, setInitialCreoLabel, () => { resetInitial(); setReportStatus('Creo folder selected'); }, resetInitial);
  const handleCorrectedCreoFolder = e => handleFolderSelection(e, setCorrectedCreoFiles, setCorrectedCreoLabel, () => { resetComparison(); setReportStatus('Corrected folder selected'); }, resetComparison);

  const buildDrawingDataUrls = async (files) => {
    const map = new Map();
    for (const f of files) {
      const url = await fileToDataUrl(f.sourceFile);
      addDrawingAlias(map, f.name, url);
      addDrawingAlias(map, f.path, url);
      addDrawingAlias(map, f.sourceFile?.webkitRelativePath, url);
    }
    return map;
  };

  const openReportFile = async (report, title, compReport = null) => {
    if (!report) return;
    const drawingDataUrls = await buildDrawingDataUrls(referenceFiles);
    const html = buildReportHtml(report, title, compReport, drawingDataUrls);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  };

  const downloadPdfDirect = async (report, title, compReport = null) => {
    if (!report) return;
    try {
      // Load jsPDF and html2canvas from CDN if not already loaded
      if (!window.jspdf) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      if (!window.html2canvas) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const drawingDataUrls = await buildDrawingDataUrls(referenceFiles);
      const html = buildReportHtml(report, title, compReport, drawingDataUrls);
      
      // Create temporary container
      const tempContainer = document.createElement('div');
      tempContainer.innerHTML = html;
      tempContainer.style.position = 'fixed';
      tempContainer.style.top = '-9999px';
      tempContainer.style.left = '-9999px';
      tempContainer.style.width = '1200px';
      document.body.appendChild(tempContainer);

      const reportContent = tempContainer.querySelector('#report-content');
      if (!reportContent) throw new Error('Report content not found');

      // Hide top bar before capture
      const topBar = reportContent.querySelector('.top-bar');
      if (topBar) topBar.style.display = 'none';

      // Wait for all images to load
      const images = reportContent.querySelectorAll('img');
      await Promise.all(Array.from(images).map(img => 
        new Promise(resolve => {
          if (img.complete) {
            resolve();
          } else {
            img.onload = resolve;
            img.onerror = resolve; // Resolve even if image fails to load
          }
        })
      ));

      // Wait a bit for rendering
      await new Promise(r => setTimeout(r, 500));

      // Capture to canvas
      const canvas = await window.html2canvas(reportContent, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#f8f9fc',
        logging: false,
      });

      // Generate PDF using jsPDF
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = pdf.internal.pageSize.getHeight();
      const ratio = canvas.width / canvas.height;
      const imgW = pdfW;
      const imgH = imgW / ratio;
      
      let posY = 0;
      let remaining = imgH;
      let firstPage = true;
      
      while (remaining > 0) {
        if (!firstPage) pdf.addPage();
        const sliceH = Math.min(pdfH, remaining);
        const srcY = posY * (canvas.height / imgH);
        const srcH = sliceH * (canvas.height / imgH);
        
        // Crop canvas slice
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = srcH;
        const ctx = sliceCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
        const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
        
        pdf.addImage(sliceData, 'JPEG', 0, 0, imgW, sliceH);
        posY += sliceH;
        remaining -= sliceH;
        firstPage = false;
      }

      // Save PDF
      pdf.save(title + '.pdf');
      
      // Clean up
      document.body.removeChild(tempContainer);
    } catch (e) {
      openAlert('PDF download failed: ' + (e instanceof Error ? e.message : String(e)), 'Download error');
    }
  };

  const handleGenerateOutput = async () => {
    if (!referenceFiles.length || !initialCreoFiles.length || isGenerating) {
      openAlert('Please select both the input folder and the Creo folder first.'); return;
    }
    setIsGenerating(true); setReportError(''); setReportStatus('Analyzing…');
    try {
      const res = await fetch('/api/analyze', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ referenceFiles: await buildFolderPayload(referenceFiles), creoFiles: await buildFolderPayload(initialCreoFiles) }) });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) throw new Error(result.error || result.message || 'Analysis failed.');
      const report = result.report || result;
      setInitialReport(report);
      setGeneratedAt(formatTimestamp(new Date(report.generatedAt || Date.now())));
      setReportStatus('Initial report ready');
    } catch(e) {
      const msg = e instanceof Error ? e.message : 'Analysis failed.';
      setReportError(msg); openAlert(msg, 'Analysis error');
    } finally { setIsGenerating(false); }
  };

  const handleRunComparison = async () => {
    if (!referenceFiles.length || !correctedCreoFiles.length || !initialReport || isGeneratingComparison) {
      openAlert('Generate the initial report first, then select the corrected Creo folder.', 'Comparison setup'); return;
    }
    setIsGeneratingComparison(true); setReportError(''); setReportStatus('Comparing…');
    try {
      const res = await fetch('/api/run-comparison', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ referenceFiles: await buildFolderPayload(referenceFiles), creoFiles: await buildFolderPayload(correctedCreoFiles) }) });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) throw new Error(result.error || result.message || 'Comparison failed.');
      const report = result.report || result;
      setComparisonReport(report);
      setComparisonGeneratedAt(formatTimestamp(new Date(report.generatedAt || Date.now())));
      setReportStatus('Comparison report ready');
    } catch(e) {
      const msg = e instanceof Error ? e.message : 'Comparison failed.';
      setReportError(msg); openAlert(msg, 'Comparison error');
    } finally { setIsGeneratingComparison(false); }
  };

  const initialIssueCount = initialReport?.summary?.total_issues ?? 0;
  const comparisonIssueCount = comparisonReport?.summary?.total_issues ?? 0;
  const issueDelta = initialReport && comparisonReport ? initialIssueCount - comparisonIssueCount : null;
  const issuesResolved = issueDelta !== null && issueDelta > 0 ? issueDelta : null;

  const groupIssues = report => {
    if (!report?.pages?.length) return [];
    const counts = {};
    for (const p of report.pages) {
      const k = p.document||p.file||p.path||'Unknown';
      counts[k] = (counts[k]||0) + Number(p.issue_count??p.issueCount??p.issues?.length??p.issues_count??0);
    }
    return Object.entries(counts).map(([document, issues]) => ({ document, issues }));
  };

  const initialFileStats = groupIssues(initialReport);
  const comparisonFileStats = groupIssues(comparisonReport);
  const comparisonRows = (() => {
    if (!initialReport || !comparisonReport) return [];
    const im = Object.fromEntries(initialFileStats.map(i=>[i.document,i.issues]));
    const cm = Object.fromEntries(comparisonFileStats.map(i=>[i.document,i.issues]));
    return Array.from(new Set([...Object.keys(im),...Object.keys(cm)])).sort().map(d=>({document:d,initial:im[d]??0,comparison:cm[d]??0}));
  })();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;
          --bg:#f3f7fb;--bg-accent:#eef4fb;--panel:rgba(255,255,255,.92);--panel-border:rgba(15,23,42,.08);
          --text:#111827;--muted:#6b7280;--accent:#6366f1;--accent-strong:#2563eb;--success:#16a34a;
          --shadow:0 20px 40px rgba(15,23,42,.08);}
        *{box-sizing:border-box} html,body,#root{min-height:100%}
        body{margin:0;color:var(--text);background:linear-gradient(180deg,#f9fbfe 0%,#eef4fb 48%,#dde7f1 100%)}
        body::before{content:'';position:fixed;inset:0;pointer-events:none;
          background-image:linear-gradient(rgba(15,23,42,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.02) 1px,transparent 1px);
          background-size:56px 56px}
        button,input,select{font:inherit} button{color:inherit}
        .app-shell{width:min(1200px,calc(100% - 32px));margin:0 auto;padding:40px 0 56px}
        .hero{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:32px}
        .hero-copyblock{flex:1}
        .eyebrow{margin:0 0 10px;letter-spacing:.12em;text-transform:uppercase;font-size:.72rem;color:var(--text)}
        .hero-copyblock h1{margin:0;max-width:760px;font-size:clamp(2rem,4vw,3.9rem);line-height:1.03}
        .badge-label,.panel-kicker,.info-card span,.output-metrics span{letter-spacing:.12em;text-transform:uppercase;font-size:.72rem;color:var(--muted)}
        .hero-badge{min-width:220px;padding:18px 20px;border:1px solid var(--panel-border);border-radius:20px;background:#fff;box-shadow:var(--shadow);align-self:end}
        .hero-badge strong{display:block;margin-top:8px;font-size:1.2rem}
        .panel{position:relative;overflow:hidden;border:1px solid var(--panel-border);border-radius:28px;background:var(--panel);box-shadow:var(--shadow)}
        .panel::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(99,102,241,.03),transparent 42%);pointer-events:none}
        .configure-panel{padding:32px;background:#fff}
        .output-panel{padding:32px;background:#f8fbff;display:flex;flex-direction:column;gap:20px}
        .panel-header{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:24px}
        .panel h2{margin:8px 0 0;font-size:1.35rem}

        /* Run cards side-by-side */
        .run-grid{display:grid;gap:20px;grid-template-columns:repeat(2,minmax(0,1fr))}
        .run-card{display:flex;flex-direction:column;gap:14px;padding:22px;border-radius:20px;border:1px solid rgba(148,163,184,.2);background:#fff}
        .run-card-secondary{background:#f8fafc}
        .run-card-title{display:flex;align-items:center;gap:10px;margin-bottom:4px}
        .run-num{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-size:13px;font-weight:700;flex-shrink:0}
        .run-num-2{background:#0ea5e9}
        .run-card h3{font-size:1rem;font-weight:700;margin:0}
        .run-card-status{margin-left:auto}
        .run-copy{color:var(--muted);font-size:.9rem;margin:0}
        .field-label{font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px;display:block}

        /* Upload zones */
        .upload-zone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:18px 14px;border:2px dashed rgba(148,163,184,.4);border-radius:14px;background:#f8fafc;cursor:pointer;transition:border-color .15s,background .15s;text-align:center;width:100%}
        .upload-zone:hover{border-color:var(--accent);background:#eef2ff}
        .upload-zone.filled{border-color:rgba(99,102,241,.35);background:#eef2ff;border-style:solid}
        .upload-icon{font-size:1.4rem;opacity:.6}
        .upload-name{font-size:.88rem;font-weight:600;color:var(--text)}
        .upload-sub{font-size:.78rem;color:var(--muted)}
        .upload-reused{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:.85rem;color:#16a34a;font-weight:600}

        /* Generate button */
        .generate-button{width:100%;min-height:48px;padding:0 18px;border:0;border-radius:16px;color:#0b1322;font-weight:700;font-size:.95rem;background:linear-gradient(90deg,#7b65d8 0%,#2da6bd 100%);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:10px;transition:transform .16s,filter .16s,opacity .16s;margin-top:4px}
        .generate-button:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.04)}
        .generate-button:disabled{opacity:.46;cursor:not-allowed}
        @keyframes spin{to{transform:rotate(360deg)}}
        .btn-spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}

        /* Status row */
        .status-row{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid rgba(148,163,184,.18);margin-top:20px}
        .status-cell{padding:14px 20px;display:flex;flex-direction:column;gap:3px}
        .status-cell:first-child{border-right:1px solid rgba(148,163,184,.18)}
        .status-cell span{font-size:.72rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
        .status-cell strong{font-size:.9rem;color:var(--text);font-weight:600}
        .status-ok{color:var(--success)!important}

        /* Format selector */
        .format-select-wrap{margin-bottom:20px}
        .custom-select{position:relative}
        .custom-select-trigger{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-radius:14px;border:1px solid rgba(148,163,184,.2);color:var(--text);background:#f8fafc;cursor:pointer;font-weight:500}
        .custom-select-trigger:hover{border-color:rgba(99,102,241,.4)}
        .caret{transition:transform .16s}
        .caret.open{transform:rotate(180deg)}
        .custom-select-menu{position:absolute;z-index:20;top:calc(100% + 8px);left:0;right:0;padding:8px;border-radius:16px;border:1px solid rgba(148,163,184,.2);background:#fff;box-shadow:0 24px 60px rgba(15,23,42,.1)}
        .custom-select-option{width:100%;display:block;padding:11px 14px;border:0;border-radius:12px;background:transparent;color:var(--text);text-align:left;cursor:pointer}
        .custom-select-option:hover,.custom-select-option.active{background:rgba(99,102,241,.08);color:var(--accent);font-weight:600}

        /* Output panel — report cards */
        .output-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:4px}
        .output-metrics{display:flex;gap:10px}
        .metric-chip{padding:8px 12px;border-radius:12px;background:rgba(255,255,255,.7);border:1px solid rgba(148,163,184,.18)}
        .metric-chip span{display:block;font-size:.68rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
        .metric-chip strong{display:block;margin-top:3px;font-size:1rem;font-weight:700;color:var(--text)}
        .report-cards-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
        .report-card{padding:22px;border-radius:22px;border:1px solid rgba(148,163,184,.18);border-left:4px solid #6366f1;background:#fff;display:flex;flex-direction:column;gap:14px}
        .report-card-2{background:#f0f9ff;border-left-color:#0ea5e9}
        .rc-header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
        .rc-title{display:flex;align-items:center;gap:8px}
        .rc-badge{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:10px;background:rgba(99,102,241,.12);color:#4338ca;font-weight:700;font-size:.9rem}
        .rc-badge-2{background:rgba(14,165,233,.12);color:#0ea5e9}
        .rc-title h3{margin:0;font-size:1rem;font-weight:700}
        .status-pill{display:inline-flex;align-items:center;padding:5px 12px;border-radius:999px;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
        .pill-done{background:rgba(20,184,166,.12);color:#047857}
        .pill-wait{background:rgba(249,115,22,.1);color:#c2410c}
        .rc-desc{font-size:.88rem;color:var(--muted);margin:0}
        .rc-meta{display:flex;flex-direction:column;gap:6px}
        .rc-meta-row{display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--muted)}
        .rc-meta-row strong{color:var(--text);font-weight:600}
        .rc-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:14px;border-radius:14px;background:rgba(248,250,252,.9);border:1px solid rgba(148,163,184,.14)}
        .rc-sum-item{display:flex;flex-direction:column;gap:3px}
        .rc-sum-item span{font-size:.7rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
        .rc-sum-item strong{font-size:1.15rem;font-weight:700;color:var(--text)}
        .rc-placeholder{min-height:72px;padding:16px;border-radius:14px;background:rgba(248,250,252,.9);border:1px dashed rgba(148,163,184,.3);display:flex;align-items:center;justify-content:center;font-size:.88rem;color:var(--muted);font-style:italic}
        .rc-file-table{border-radius:12px;overflow:hidden;border:1px solid rgba(148,163,184,.14)}
        .rc-file-header{display:grid;grid-template-columns:1.4fr .8fr .8fr;padding:8px 12px;background:rgba(241,245,249,.9);font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
        .rc-file-row{display:grid;grid-template-columns:1.4fr .8fr .8fr;padding:9px 12px;border-top:1px solid rgba(148,163,184,.1);font-size:.85rem;align-items:center}
        .rc-file-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
        .rc-file-row strong{text-align:right;font-weight:700}
        .rc-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:auto}
        .btn-open{flex:1;min-height:42px;padding:0 14px;border-radius:999px;border:1px solid rgba(99,102,241,.25);background:#fff;color:#111827;font-weight:600;font-size:.88rem;cursor:pointer;transition:border-color .15s}
        .btn-open:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
        .btn-open:disabled{opacity:.4;cursor:not-allowed}
        .btn-download{flex:1;min-height:42px;padding:0 14px;border-radius:999px;border:0;background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;font-weight:600;font-size:.88rem;cursor:pointer;box-shadow:0 4px 14px rgba(139,92,246,.3);transition:transform .15s,box-shadow .15s;display:inline-flex;align-items:center;justify-content:center;gap:7px}
        .btn-download:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(139,92,246,.4)}
        .btn-download:disabled{opacity:.4;cursor:not-allowed}

        .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
        .modal-backdrop{position:fixed;inset:0;z-index:40;display:grid;place-items:center;padding:24px;background:rgba(3,7,18,.55);backdrop-filter:blur(8px)}
        .modal-card{width:min(520px,100%);padding:28px;border-radius:26px;border:1px solid rgba(255,255,255,.1);background:rgba(248,250,252,.98);color:#0f172a;box-shadow:0 30px 80px rgba(0,0,0,.35)}
        .modal-card h3{margin:0 0 10px;font-size:1.25rem}
        .modal-card p{margin:0;line-height:1.6;color:rgba(15,23,42,.75)}
        .modal-actions{display:flex;justify-content:flex-end;margin-top:20px}
        .primary-button{min-height:42px;padding:0 20px;border-radius:12px;border:0;cursor:pointer;background:#111;color:#fff;font-weight:600}
        @media(max-width:900px){.run-grid{grid-template-columns:1fr}.report-cards-grid{grid-template-columns:1fr}}
        @media(max-width:640px){.app-shell{padding-top:18px}.configure-panel,.output-panel{padding:18px}.hero{flex-direction:column}}
      `}</style>

      <main className="app-shell">
        {/* ── HERO ── */}
        <header className="hero">
          <div className="hero-copyblock">
            <p className="eyebrow">CREO FILE WORKSPACE</p>
            <h1>Choose a native format and inspect the Creo folder output in one place.</h1>
          </div>
          <div className="hero-badge">
            <span className="badge-label">Selected format</span>
            <strong>{selectedFormatLabel}</strong>
          </div>
        </header>

        {/* ── CONFIGURE SOURCE PANEL ── */}
        <div className="panel configure-panel" style={{marginBottom:24}}>
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Configure source</h2>
            </div>
            {/* Format selector top-right */}
            <div style={{minWidth:200}} ref={formatMenuRef}>
              <div className="custom-select">
                <button type="button" className="custom-select-trigger" onClick={() => setFormatMenuOpen(o=>!o)}>
                  <span>{selectedFormatLabel}</span>
                  <span className={`caret ${formatMenuOpen?'open':''}`}>▾</span>
                </button>
                {formatMenuOpen && (
                  <div className="custom-select-menu" role="listbox">
                    {nativeFormats.map(item => (
                      <button key={item.value} type="button"
                        className={`custom-select-option ${item.value===nativeFormat?'active':''}`}
                        onClick={() => { setNativeFormat(item.value); setFormatMenuOpen(false); }}>
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="run-grid">
            {/* 1st run */}
            <div className="run-card">
              <div className="run-card-title">
                <span className="run-num">1</span>
                <h3>1st run · Initial report</h3>
                <span className="run-card-status">
                  <span className={`status-pill ${initialReport?'pill-done':'pill-wait'}`}>
                    {initialReport?'Completed':'Pending'}
                  </span>
                </span>
              </div>

              <div>
                <span className="field-label">PDF files (reference)</span>
                <button type="button" className={`upload-zone ${referenceFiles.length?'filled':''}`}
                  onClick={() => referenceFolderInputRef.current?.click()}>
                  <span className="upload-icon">⬆</span>
                  {referenceFiles.length ? (
                    <><span className="upload-name">{referenceFiles.length} PDF files selected</span><span className="upload-sub">{referenceFiles.length} files detected</span></>
                  ) : (
                    <><span className="upload-name">Click to select reference PDFs</span><span className="upload-sub">No files selected yet</span></>
                  )}
                </button>
                <input ref={referenceFolderInputRef} className="sr-only" type="file" webkitdirectory="" multiple accept=".pdf,application/pdf" onChange={handleReferenceFolder}/>
              </div>

              <div>
                <span className="field-label">Creo PDF files</span>
                <button type="button" className={`upload-zone ${initialCreoFiles.length?'filled':''}`}
                  onClick={() => initialCreoFolderInputRef.current?.click()}>
                  <span className="upload-icon">⬆</span>
                  {initialCreoFiles.length ? (
                    <><span className="upload-name">{initialCreoFiles.length} PDF files selected</span><span className="upload-sub">{initialCreoFiles.length} files detected</span></>
                  ) : (
                    <><span className="upload-name">Click to select Creo PDFs</span><span className="upload-sub">No files selected yet</span></>
                  )}
                </button>
                <input ref={initialCreoFolderInputRef} className="sr-only" type="file" webkitdirectory="" multiple accept=".pdf,application/pdf" onChange={handleInitialCreoFolder}/>
              </div>

              <button type="button" className="generate-button"
                disabled={!referenceFiles.length||!initialCreoFiles.length||isGenerating}
                onClick={handleGenerateOutput}>
                {isGenerating ? <><span className="btn-spinner"/><span>Analyzing drawings…</span></> : <>Generate initial output →</>}
              </button>
            </div>

            {/* 2nd run */}
            <div className="run-card run-card-secondary">
              <div className="run-card-title">
                <span className="run-num run-num-2">2</span>
                <h3>2nd run · Comparison report</h3>
                <span className="run-card-status">
                  <span className={`status-pill ${comparisonReport?'pill-done':'pill-wait'}`}>
                    {comparisonReport?'Completed':'Pending'}
                  </span>
                </span>
              </div>

              <div className="upload-reused">
                ✓ Reference PDFs reused from 1st run · <strong>{referenceFiles.length} files</strong>
              </div>

              <div>
                <span className="field-label">Creo Corrected PDF files</span>
                <button type="button" className={`upload-zone ${correctedCreoFiles.length?'filled':''}`}
                  onClick={() => correctedCreoFolderInputRef.current?.click()}>
                  <span className="upload-icon">⬆</span>
                  {correctedCreoFiles.length ? (
                    <><span className="upload-name">{correctedCreoFiles.length} PDF files selected</span><span className="upload-sub">{correctedCreoFiles.length} files detected</span></>
                  ) : (
                    <><span className="upload-name">Click to select corrected Creo PDFs</span><span className="upload-sub">No files selected yet</span></>
                  )}
                </button>
                <input ref={correctedCreoFolderInputRef} className="sr-only" type="file" webkitdirectory="" multiple accept=".pdf,application/pdf" onChange={handleCorrectedCreoFolder}/>
              </div>

              <button type="button" className="generate-button"
                disabled={!referenceFiles.length||!correctedCreoFiles.length||!initialReport||isGeneratingComparison}
                onClick={handleRunComparison}>
                {isGeneratingComparison ? <><span className="btn-spinner"/><span>Comparing drawings…</span></> : <>Generate comparison output →</>}
              </button>
            </div>
          </div>

          <div className="status-row">
            <div className="status-cell"><span>Selected Format</span><strong>{selectedFormatLabel}</strong></div>
            <div className="status-cell"><span>Status</span>
              <strong className={outputStatus.toLowerCase().includes('ready')||outputStatus.toLowerCase().includes('success')?'status-ok':''}>
                {outputStatus}
              </strong>
            </div>
          </div>
        </div>

        {/* ── OUTPUT PANEL ── */}
        <div className="panel output-panel">
          <div className="output-header">
            <div>
              <p className="panel-kicker">Output</p>
              <h2>Reports</h2>
            </div>
            <div className="output-metrics">
              <div className="metric-chip"><span>Reference PDFs</span><strong>{summary.referenceCount}</strong></div>
              <div className="metric-chip"><span>Creo PDFs</span><strong>{summary.initialCreoCount}</strong></div>
              <div className="metric-chip"><span>Corrected PDFs</span><strong>{summary.correctedCreoCount}</strong></div>
            </div>
          </div>

          <div className="report-cards-grid">
            {/* Initial report card */}
            <div className="report-card">
              <div className="rc-header">
                <div className="rc-title">
                  <span className="rc-badge">🔍</span>
                  <div>
                    <h3>Initial Compliance Report</h3>
                    <span style={{fontSize:'.72rem',fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'#6366f1'}}>1ST RUN</span>
                  </div>
                </div>
                <span className={`status-pill ${initialReport?'pill-done':'pill-wait'}`}>{initialReport?'Completed':'Awaiting 1st run'}</span>
              </div>
              <p className="rc-desc">Baseline audit between source drawings and Creo review drawings.</p>

              {isGenerating ? (
                <div style={{padding:'8px 0'}}><LoadingSpinner label="Generating initial report"/></div>
              ) : initialReport ? (
                <div className="rc-meta">
                  <div className="rc-meta-row">📄 Generated: <strong>{generatedAt}</strong></div>
                  <div className="rc-meta-row">📋 Pages Analyzed: <strong>{initialReport?.pages?.length??'—'}</strong></div>
                  <div className="rc-meta-row">⚠ Issues Flagged: <strong style={{color:'#dc2626'}}>{initialReport?.summary?.total_issues??'—'}</strong></div>
                </div>
              ) : (
                <div className="rc-placeholder">Initial report will appear here after the first run.</div>
              )}

              {initialReport && !isGenerating && (
                <div className="rc-summary">
                  <div className="rc-sum-item"><span>Pages</span><strong>{initialReport?.pages?.length??'—'}</strong></div>
                  <div className="rc-sum-item"><span>Issues</span><strong style={{color:'#dc2626'}}>{initialReport?.summary?.total_issues??'—'}</strong></div>
                  <div className="rc-sum-item"><span>Score</span><strong>{initialReport?.summary?.overall_score??'—'}</strong></div>
                </div>
              )}

              <div className="rc-actions">
                <button className="btn-open" disabled={!initialReport}
                  onClick={() => openReportFile(initialReport,'Initial Compliance Report')}>Open report</button>
                <button className="btn-download" disabled={!initialReport}
                  onClick={() => downloadPdfDirect(initialReport,'Initial Compliance Report')}>
                  ⬇ Download PDF
                </button>
              </div>
            </div>

            {/* Comparison report card */}
            <div className="report-card report-card-2">
              <div className="rc-header">
                <div className="rc-title">
                  <span className="rc-badge rc-badge-2">🔍</span>
                  <div>
                    <h3>Comparison Report</h3>
                    <span style={{fontSize:'.72rem',fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'#0ea5e9'}}>2ND RUN</span>
                  </div>
                </div>
                <span className={`status-pill ${comparisonReport?'pill-done':'pill-wait'}`}>{comparisonReport?'Completed':'Awaiting 2nd run'}</span>
              </div>
              <p className="rc-desc">Diff between initial Creo review and corrected Creo drawings.</p>

              {isGeneratingComparison ? (
                <div style={{padding:'8px 0'}}><LoadingSpinner label="Generating comparison report"/></div>
              ) : comparisonReport ? (
                <div className="rc-meta">
                  <div className="rc-meta-row">📄 Generated: <strong>{comparisonGeneratedAt}</strong></div>
                  <div className="rc-meta-row">📋 Pages Analyzed: <strong>{comparisonReport?.pages?.length??'—'}</strong></div>
                  <div className="rc-meta-row">⚠ Issues Flagged: <strong style={{color:'#dc2626'}}>{comparisonReport?.summary?.total_issues??'—'}</strong></div>
                  {issuesResolved!==null && <div className="rc-meta-row">✅ Issues Resolved: <strong style={{color:'#16a34a'}}>{issuesResolved}</strong></div>}
                </div>
              ) : (
                <div className="rc-placeholder">Comparison report will appear here after the second run.</div>
              )}

              {comparisonReport && !isGeneratingComparison && (
                <>
                  <div className="rc-summary">
                    <div className="rc-sum-item"><span>Issues</span><strong style={{color:'#dc2626'}}>{comparisonReport?.summary?.total_issues??'—'}</strong></div>
                    <div className="rc-sum-item"><span>Resolved</span><strong style={{color:'#16a34a'}}>{issuesResolved??'—'}</strong></div>
                    <div className="rc-sum-item"><span>Score</span><strong>{comparisonReport?.summary?.overall_score??'—'}</strong></div>
                  </div>
                  {comparisonRows.length > 0 && (
                    <div className="rc-file-table">
                      <div className="rc-file-header"><span>File</span><span style={{textAlign:'right'}}>Initial</span><span style={{textAlign:'right'}}>Corrected</span></div>
                      {comparisonRows.map(row => (
                        <div key={row.document} className="rc-file-row">
                          <span>{row.document}</span>
                          <strong style={{color:'#dc2626',textAlign:'right'}}>{row.initial}</strong>
                          <strong style={{color:'#16a34a',textAlign:'right'}}>{row.comparison}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="rc-actions">
                <button className="btn-open" disabled={!comparisonReport}
                  onClick={() => openReportFile(comparisonReport,'Comparison Report',initialReport)}>Open report</button>
                <button className="btn-download" disabled={!comparisonReport}
                  onClick={() => downloadPdfDirect(comparisonReport,'Comparison Report',initialReport)}>
                  ⬇ Download PDF
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── ALERT MODAL ── */}
        {alertOpen && (
          <div className="modal-backdrop" onClick={closeAlert}>
            <div className="modal-card" role="dialog" aria-modal="true" onClick={e=>e.stopPropagation()}>
              <h3>{alertTitle}</h3>
              <p>{alertMessage}</p>
              <div className="modal-actions">
                <button type="button" className="primary-button" onClick={closeAlert}>OK</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
