import { useEffect, useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';

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
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function buildFolderPayload(files) {
  return await Promise.all(
    files.map(async (entry) => ({
      name: entry.name,
      path: entry.path,
      size: entry.size,
      type: entry.type,
      dataUrl: await fileToDataUrl(entry.sourceFile),
    })),
  );
}

function stringifyReport(report) {
  return JSON.stringify(report, null, 2);
}

function App() {
  const [nativeFormat, setNativeFormat] = useState(nativeFormats[0].value);
  const [referenceFiles, setReferenceFiles] = useState([]);
  const [initialCreoFiles, setInitialCreoFiles] = useState([]);
  const [correctedCreoFiles, setCorrectedCreoFiles] = useState([]);
  const [referenceLabel, setReferenceLabel] = useState('');
  const [initialCreoLabel, setInitialCreoLabel] = useState('');
  const [correctedCreoLabel, setCorrectedCreoLabel] = useState('');
  const [initialReport, setInitialReport] = useState(null);
  const [comparisonReport, setComparisonReport] = useState(null);
  const [initialReportText, setInitialReportText] = useState('');
  const [comparisonReportText, setComparisonReportText] = useState('');
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

  const selectedFormatLabel =
    nativeFormats.find((item) => item.value === nativeFormat)?.label ?? nativeFormat;

  const summary = useMemo(() => {
    const allFiles = [...referenceFiles, ...initialCreoFiles, ...correctedCreoFiles];
    return {
      referenceCount: referenceFiles.length,
      initialCreoCount: initialCreoFiles.length,
      correctedCreoCount: correctedCreoFiles.length,
      size: formatBytes(allFiles.reduce((acc, file) => acc + file.size, 0)),
    };
  }, [referenceFiles, initialCreoFiles, correctedCreoFiles]);

  const outputStatus = reportError
    ? reportError
    : comparisonReport
      ? 'Comparison JSON generated successfully'
      : initialReport
        ? 'Initial issue JSON generated successfully'
        : reportStatus;

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(event.target)) {
        setFormatMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const openAlert = (message, title = 'Folder selection') => {
    setAlertMessage(message);
    setAlertTitle(title);
    setAlertOpen(true);
  };

  const closeAlert = () => {
    setAlertOpen(false);
    setAlertMessage('');
    setAlertTitle('Folder selection');
  };

  const toFolderFileEntries = (files) =>
    files.map((file) => ({
      sourceFile: file,
      name: file.name,
      path: file.webkitRelativePath || file.name,
      size: file.size,
      type: file.type || 'application/pdf',
    }));

  const resetInitialReportState = () => {
    setInitialReport(null);
    setInitialReportText('');
    setComparisonReport(null);
    setComparisonReportText('');
    setGeneratedAt('');
    setComparisonGeneratedAt('');
    setReportError('');
  };

  const resetComparisonReportState = () => {
    setComparisonReport(null);
    setComparisonReportText('');
    setComparisonGeneratedAt('');
    setReportError('');
  };

  const handleFolderSelection = (event, setFiles, setLabel, onSuccess, onInvalid) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) {
      event.target.value = '';
      return;
    }

    const invalidFile = files.find((file) => !isPdfFile(file));
    if (invalidFile) {
      setFiles([]);
      setLabel('');
      onInvalid?.();
      openAlert('Only PDF files are allowed. Please select a folder that contains PDF files only.');
      event.target.value = '';
      return;
    }

    const enriched = toFolderFileEntries(files);
    setFiles(enriched);
    setLabel(folderLabel(files));
    onSuccess?.();
    event.target.value = '';
  };

  const handleReferenceFolder = (event) => {
    handleFolderSelection(event, setReferenceFiles, setReferenceLabel, () => {
      resetInitialReportState();
      setReportStatus('Input folder selected, ready for the initial run');
    }, resetInitialReportState);
  };

  const handleInitialCreoFolder = (event) => {
    handleFolderSelection(event, setInitialCreoFiles, setInitialCreoLabel, () => {
      resetInitialReportState();
      setReportStatus('Creo folder selected, ready for the initial run');
    }, resetInitialReportState);
  };

  const handleCorrectedCreoFolder = (event) => {
    handleFolderSelection(event, setCorrectedCreoFiles, setCorrectedCreoLabel, () => {
      resetComparisonReportState();
      setReportStatus('Corrected Creo folder selected, ready for comparison');
    }, resetComparisonReportState);
  };

  const openFolderPicker = (ref) => {
    ref.current?.click();
  };

  const downloadJson = (report, filename) => {
    if (!report) return;

    const blob = new Blob([stringifyReport(report)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const buildReportHtml = (report, title) => {
    const generatedAt = report?.generatedAt ? formatTimestamp(new Date(report.generatedAt)) : '—';
    const summary = report?.summary || {};
    const folders = report?.folders || {};
    const fileRows = groupIssueCountsByDocument(report);
    const isComparison = report?.mode === 'comparison';

    const tableRows = fileRows.map((row) => `
      <tr>
        <td>${row.document}</td>
        <td>${row.issues}</td>
        <td>${isComparison ? row.issues : '—'}</td>
      </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #eef4fb; color: #111827; }
  .report-shell { max-width: 960px; margin: 40px auto; padding: 32px; background: #fff; border-radius: 28px; box-shadow: 0 20px 70px rgba(15,23,42,0.08); }
  .header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
  .header h1 { margin:0; font-size: clamp(1.8rem, 2.5vw, 2.4rem); }
  .badge { display:inline-flex; align-items:center; gap:8px; padding:10px 16px; border-radius:999px; background:#ecfdf5; color:#047857; font-weight:700; text-transform:uppercase; font-size:0.8rem; }
  .section { margin-top:28px; }
  .section h2 { margin:0 0 14px; font-size:1.1rem; }
  .grid { display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .metric { padding:18px 20px; border-radius:18px; background:#f8fafc; border:1px solid rgba(148,163,184,0.16); }
  .metric span { display:block; color:#6b7280; font-size:0.85rem; }
  .metric strong { margin-top:6px; display:block; font-size:1.05rem; }
  table { width:100%; border-collapse:collapse; margin-top:18px; font-size:0.95rem; }
  th, td { padding:14px 12px; border-bottom:1px solid rgba(148,163,184,0.14); }
  th { text-align:left; color:#6b7280; font-weight:700; }
  td strong { color:#111827; }
  .json-block { margin:0; width:100%; min-height:280px; max-height:550px; padding:18px; border-radius:18px; background:#0f172a; color:#f8fafc; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:0.82rem; line-height:1.5; overflow:auto; white-space:pre-wrap; word-break:break-word; border:1px solid rgba(148,163,184,0.16); }
  .footer { margin-top:28px; color:#475569; line-height:1.7; }
</style>
</head>
<body>
  <div class="report-shell">
    <div class="header">
      <div>
        <p class="badge">${isComparison ? 'Comparison Report' : 'Initial Report'}</p>
        <h1>${title}</h1>
        <p>${isComparison ? 'Comparison report of corrected Creo output vs initial review.' : 'Initial compliance report for the first Creo folder run.'}</p>
      </div>
      <div class="metric">
        <span>Generated</span>
        <strong>${generatedAt}</strong>
      </div>
    </div>

    <div class="section">
      <h2>Summary</h2>
      <div class="grid">
        <div class="metric"><span>Reference PDFs</span><strong>${folders.reference ?? '—'}</strong></div>
        <div class="metric"><span>Creo PDFs</span><strong>${folders.creo ?? '—'}</strong></div>
        <div class="metric"><span>Pages analyzed</span><strong>${report.pages?.length ?? '—'}</strong></div>
        <div class="metric"><span>Issues flagged</span><strong>${summary.total_issues ?? '—'}</strong></div>
        <div class="metric"><span>${isComparison ? 'Issues resolved' : 'Score'}</span><strong>${isComparison ? (summary.issues_resolved || summary.issuesResolved || summary.resolved_issues || '—') : (summary.overall_score ?? '—')}</strong></div>
      </div>
    </div>

    ${fileRows.length ? `
    <div class="section">
      <h2>Issues per file</h2>
      <table>
        <thead>
          <tr><th>Document</th><th>Issues</th></tr>
        </thead>
        <tbody>
          ${fileRows.map((row) => `
            <tr>
              <td>${row.document}</td>
              <td>${row.issues}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <div class="section">
      <h2>Full issue JSON</h2>
      <pre class="json-block">${stringifyReport(report)}</pre>
    </div>

    <div class="footer">
      <p>Report generated from your current run. Download PDF if you need a printable version.</p>
    </div>
  </div>
</body>
</html>`;
  };

  const openReportFile = (report, title) => {
    if (!report) return;
    const html = buildReportHtml(report, title);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const downloadReportPdf = (report, filename, title) => {
    if (!report) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    let y = 50;
    doc.setFontSize(18);
    doc.setTextColor('#111827');
    doc.text(title, margin, y);
    y += 28;
    doc.setFontSize(11);
    doc.setTextColor('#475569');
    doc.text(`Generated: ${report.generatedAt ? formatTimestamp(new Date(report.generatedAt)) : '—'}`, margin, y);
    y += 28;
    doc.setFontSize(12);
    doc.setTextColor('#111827');
    doc.text('Summary', margin, y);
    y += 20;

    const summary = report.summary || {};
    const folders = report.folders || {};
    const summaryLines = [
      `Reference PDFs: ${folders.reference ?? '—'}`,
      `Creo PDFs: ${folders.creo ?? '—'}`,
      `Matched files: ${folders.matched ?? '—'}`,
      `Issues flagged: ${summary.total_issues ?? '—'}`,
      `Score: ${summary.overall_score ?? '—'}`,
    ];

    summaryLines.forEach((line) => {
      doc.text(line, margin, y);
      y += 18;
    });

    const rows = groupIssueCountsByDocument(report);
    if (rows.length) {
      y += 14;
      doc.text('Issues per file', margin, y);
      y += 18;
      doc.setFontSize(10);
      doc.setTextColor('#111827');
      doc.text('Document', margin, y);
      doc.text('Issues', 350, y);
      y += 16;
      rows.forEach((row) => {
        if (y > 750) { doc.addPage(); y = 50; }
        doc.text(String(row.document), margin, y);
        doc.text(String(row.issues), 350, y);
        y += 16;
      });
    }

    // Add full JSON to PDF
    y += 28;
    if (y > 700) { doc.addPage(); y = 50; }
    doc.setFontSize(12);
    doc.setTextColor('#111827');
    doc.text('Full issue JSON', margin, y);
    y += 18;
    doc.setFontSize(8);
    doc.setTextColor('#475569');
    
    const jsonString = stringifyReport(report);
    const maxWidth = 515;
    const jsonLines = doc.splitTextToSize(jsonString, maxWidth);
    
    jsonLines.forEach((line) => {
      if (y + 10 > 750) {
        doc.addPage();
        y = 50;
      }
      doc.text(line, margin, y);
      y += 10;
    });

    doc.save(filename);
  };

  const copyJson = async (text) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    openAlert('JSON copied to clipboard.', 'Copied');
  };

  const handleGenerateOutput = async () => {
    if (!referenceFiles.length || !initialCreoFiles.length || isGenerating) {
      openAlert('Please select the input folder and the first Creo folder before generating the initial output.');
      return;
    }

    setIsGenerating(true);
    setReportError('');
    setReportStatus('Generating initial issue JSON...');

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          referenceFiles: await buildFolderPayload(referenceFiles),
          creoFiles: await buildFolderPayload(initialCreoFiles),
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || result.message || 'Failed to generate the initial report.');
      }

      const report = result.report || result;
      setInitialReport(report);
      setInitialReportText(stringifyReport(report));
      setGeneratedAt(formatTimestamp(new Date(report.generatedAt || Date.now())));
      setReportStatus('Initial issue JSON generated successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Initial analysis failed.';
      setReportError(message);
      setReportStatus(message);
      openAlert(message, 'Analysis error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRunComparison = async () => {
    if (!referenceFiles.length || !correctedCreoFiles.length || !initialReport || isGeneratingComparison) {
      openAlert(
        'Please keep the same input folder, select the corrected Creo folder, and generate the initial report first.',
        'Comparison setup',
      );
      return;
    }

    setIsGeneratingComparison(true);
    setReportError('');
    setReportStatus('Generating comparison JSON...');

    try {
      const response = await fetch('/api/run-comparison', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          referenceFiles: await buildFolderPayload(referenceFiles),
          creoFiles: await buildFolderPayload(correctedCreoFiles),
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || result.message || 'Failed to run the comparison.');
      }

      const report = result.report || result;
      setComparisonReport(report);
      setComparisonReportText(stringifyReport(report));
      setComparisonGeneratedAt(formatTimestamp(new Date(report.generatedAt || Date.now())));
      setReportStatus('Comparison JSON generated successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Comparison failed.';
      setReportError(message);
      setReportStatus(message);
      openAlert(message, 'Comparison error');
    } finally {
      setIsGeneratingComparison(false);
    }
  };

  const initialIssueCount = initialReport?.summary?.total_issues ?? 0;
  const comparisonIssueCount = comparisonReport?.summary?.total_issues ?? 0;
  const issueDelta =
    initialReport && comparisonReport ? initialIssueCount - comparisonIssueCount : null;

  const groupIssueCountsByDocument = (report) => {
    if (!report?.pages?.length) return [];
    const counts = {};

    for (const page of report.pages) {
      const documentName = page.document || page.file || page.path || 'Unknown';
      const issueCount = Number(
        page.issue_count ?? page.issueCount ?? page.issues?.length ?? page.issues_count ?? 0,
      );
      counts[documentName] = (counts[documentName] || 0) + (issueCount || 0);
    }

    return Object.entries(counts).map(([document, issues]) => ({ document, issues }));
  };

  const initialFileStats = groupIssueCountsByDocument(initialReport);
  const comparisonFileStats = groupIssueCountsByDocument(comparisonReport);

  const perFileComparisonStats = () => {
    if (!initialReport || !comparisonReport) return [];

    const initialMap = Object.fromEntries(initialFileStats.map((item) => [item.document, item.issues]));
    const comparisonMap = Object.fromEntries(comparisonFileStats.map((item) => [item.document, item.issues]));
    const documents = Array.from(new Set([...Object.keys(initialMap), ...Object.keys(comparisonMap)])).sort();

    return documents.map((document) => ({
      document,
      initial: initialMap[document] ?? 0,
      comparison: comparisonMap[document] ?? 0,
    }));
  };

  const comparisonRows = perFileComparisonStats();

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copyblock">
          <p className="eyebrow">CREO FILE WORKSPACE</p>
          <h1>Compare folder uploads, capture issue JSON, then rerun the corrected Creo folder.</h1>
          <p className="hero-copy">
           Select a target native format and upload reference and Creo PDFs. Preview the generated report in a crisp, real-time pane.
          </p>
        </div>

        <div className="hero-badge">
          <span className="badge-label">Selected format</span>
          <strong>{selectedFormatLabel}</strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel panel-input">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Input</p>
              <h2>Configure folders</h2>
            </div>
          </div>

          <div className="field-group">
            <label>Native format</label>
            <div className="custom-select" ref={formatMenuRef}>
              <button
                type="button"
                className="custom-select-trigger"
                onClick={() => setFormatMenuOpen((open) => !open)}
                aria-haspopup="listbox"
                aria-expanded={formatMenuOpen}
              >
                <span>{selectedFormatLabel}</span>
                <span className={`caret ${formatMenuOpen ? 'open' : ''}`}>v</span>
              </button>

              {formatMenuOpen ? (
                <div className="custom-select-menu" role="listbox" aria-label="Native format">
                  {nativeFormats.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`custom-select-option ${item.value === nativeFormat ? 'active' : ''}`}
                      onClick={() => {
                        setNativeFormat(item.value);
                        setFormatMenuOpen(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="run-grid">
            <div className="run-card">
              <div className="run-card-header">
                <span className="badge-label">1st run</span>
                <h3>Initial issue JSON</h3>
              </div>

              <div className="run-card-body">
                <label htmlFor="reference-folder">Input folder</label>
                <button
                  type="button"
                  className="folder-picker folder-card"
                  onClick={() => openFolderPicker(referenceFolderInputRef)}
                >
                  {referenceLabel ? (
                    <div className="folder-copy folder-copy-selected">
                      <span className="folder-icon folder-icon-selected">IN</span>
                      <strong>{referenceLabel}</strong>
                      <span>{`${referenceFiles.length} file${referenceFiles.length === 1 ? '' : 's'} detected`}</span>
                    </div>
                  ) : (
                    <div className="folder-copy folder-copy-empty">
                      <span className="folder-icon">+</span>
                      <strong>Click to select input folder</strong>
                      <span>No input folder selected yet</span>
                    </div>
                  )}
                </button>

                <input
                  id="reference-folder"
                  ref={referenceFolderInputRef}
                  className="sr-only"
                  type="file"
                  webkitdirectory=""
                  mozdirectory=""
                  directory=""
                  multiple
                  accept=".pdf,application/pdf"
                  onChange={handleReferenceFolder}
                />

                <label htmlFor="initial-creo-folder">Creo folder</label>
                <button
                  type="button"
                  className="folder-picker folder-card"
                  onClick={() => openFolderPicker(initialCreoFolderInputRef)}
                >
                  {initialCreoLabel ? (
                    <div className="folder-copy folder-copy-selected">
                      <span className="folder-icon folder-icon-selected">CR</span>
                      <strong>{initialCreoLabel}</strong>
                      <span>{`${initialCreoFiles.length} file${initialCreoFiles.length === 1 ? '' : 's'} detected`}</span>
                    </div>
                  ) : (
                    <div className="folder-copy folder-copy-empty">
                      <span className="folder-icon">+</span>
                      <strong>Click to select Creo folder</strong>
                      <span>No Creo folder selected yet</span>
                    </div>
                  )}
                </button>

                <input
                  id="initial-creo-folder"
                  ref={initialCreoFolderInputRef}
                  className="sr-only"
                  type="file"
                  webkitdirectory=""
                  mozdirectory=""
                  directory=""
                  multiple
                  accept=".pdf,application/pdf"
                  onChange={handleInitialCreoFolder}
                />

                <button
                  type="button"
                  className="generate-button"
                  disabled={!referenceFiles.length || !initialCreoFiles.length || isGenerating}
                  onClick={handleGenerateOutput}
                >
                  {isGenerating ? 'Generating...' : (
                    <>
                      Generate initial output <span>{'->'}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="run-card run-card-secondary">
              <div className="run-card-header">
                <span className="badge-label">2nd run</span>
                <h3>Comparison JSON</h3>
              </div>

              <div className="run-card-body">
                <p className="run-copy">
                  Reference folder reused from the first run · {referenceFiles.length} files
                </p>

                <label htmlFor="corrected-creo-folder">Creo corrected folder</label>
                <button
                  type="button"
                  className="folder-picker folder-card"
                  onClick={() => openFolderPicker(correctedCreoFolderInputRef)}
                >
                  {correctedCreoLabel ? (
                    <div className="folder-copy folder-copy-selected">
                      <span className="folder-icon folder-icon-selected">OK</span>
                      <strong>{correctedCreoLabel}</strong>
                      <span>{`${correctedCreoFiles.length} file${correctedCreoFiles.length === 1 ? '' : 's'} detected`}</span>
                    </div>
                  ) : (
                    <div className="folder-copy folder-copy-empty">
                      <span className="folder-icon">+</span>
                      <strong>Click to select corrected Creo folder</strong>
                      <span>No corrected Creo folder selected yet</span>
                    </div>
                  )}
                </button>

                <input
                  id="corrected-creo-folder"
                  ref={correctedCreoFolderInputRef}
                  className="sr-only"
                  type="file"
                  webkitdirectory=""
                  mozdirectory=""
                  directory=""
                  multiple
                  accept=".pdf,application/pdf"
                  onChange={handleCorrectedCreoFolder}
                />

                <button
                  type="button"
                  className="generate-button secondary"
                  disabled={!referenceFiles.length || !correctedCreoFiles.length || !initialReport || isGeneratingComparison}
                  onClick={handleRunComparison}
                >
                  {isGeneratingComparison ? 'Generating...' : (
                    <>
                      Run comparison <span>{'->'}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="info-row">
            <div className="info-card">
              <span>Selected format</span>
              <strong>{selectedFormatLabel}</strong>
            </div>
            <div className="info-card">
              <span>Status</span>
              <strong>{outputStatus}</strong>
            </div>
          </div>
        </aside>

        <section className="panel panel-output">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Output</p>
              <h2>Reports</h2>
            </div>

            <div className="output-actions">
              <div className="output-metrics">
                <div>
                  <span>Input PDFs</span>
                  <strong>{summary.referenceCount}</strong>
                </div>

                <div>
                  <span>Creo PDFs</span>
                  <strong>{summary.initialCreoCount}</strong>
                </div>

                <div>
                  <span>Corrected PDFs</span>
                  <strong>{summary.correctedCreoCount}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="report-grid">
            <article className="report-card report-card-primary">
              <div className="report-card-title">
                <div>
                  <span className="report-badge">1</span>
                  <h3>Initial Issue JSON</h3>
                </div>
                <span className={`status-pill ${initialReport ? 'status-complete' : 'status-pending'}`}>
                  {initialReport ? 'Completed' : 'Awaiting first run'}
                </span>
              </div>

              <p className="report-copy">
                Baseline audit between the input folder and the first Creo export folder.
              </p>

              <div className="report-row">
                <span>Generated</span>
                <strong>{generatedAt || '—'}</strong>
              </div>
              <div className="report-row">
                <span>Matched folders</span>
                <strong>{initialReport?.folders?.matched ?? '—'}</strong>
              </div>

              <div className="report-shell report-shell-note">
                {initialReport ? (
                  <div className="report-summary-box">
                    <div className="summary-item">
                      <span>Pages Analyzed</span>
                      <strong>{initialReport?.pages?.length ?? '—'}</strong>
                    </div>
                    <div className="summary-item">
                      <span>Issues Flagged</span>
                      <strong>{initialReport?.summary?.total_issues ?? '—'}</strong>
                    </div>
                    <div className="summary-item">
                      <span>Overall Score</span>
                      <strong>{initialReport?.summary?.overall_score ?? '—'}</strong>
                    </div>
                  </div>
                ) : (
                  <p>Initial issue JSON will appear here after the first run.</p>
                )}
              </div>

              <div className="report-card-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!initialReport}
                  onClick={() => openReportFile(initialReport, 'Initial Compliance Report')}
                >
                  Open report
                </button>
                <button
                  type="button"
                  className="download-button"
                  disabled={!initialReport}
                  onClick={() => downloadReportPdf(initialReport, 'initial-issue-report.pdf', 'Initial Compliance Report')}
                >
                  Download report
                </button>
              </div>
            </article>

            <article className="report-card report-card-secondary">
              <div className="report-card-title">
                <div>
                  <span className="report-badge report-badge-secondary">2</span>
                  <h3>Comparison JSON</h3>
                </div>
                <span className={`status-pill ${comparisonReport ? 'status-complete' : 'status-pending'}`}>
                  {comparisonReport ? 'Completed' : 'Awaiting second run'}
                </span>
              </div>

              <p className="report-copy">
                Comparison between the same input folder and the corrected Creo folder.
              </p>

              <div className="report-row">
                <span>Generated</span>
                <strong>{comparisonGeneratedAt || '—'}</strong>
              </div>
              <div className="report-row">
                <span>Issue delta vs initial</span>
                <strong>
                  {issueDelta === null ? '—' : issueDelta > 0 ? `-${issueDelta}` : `${issueDelta}`}
                </strong>
              </div>

              {initialReport && comparisonReport && comparisonRows.length ? (
                <div className="report-table">
                  <div className="report-table-header">
                    <span>File</span>
                    <span>Initial</span>
                    <span>Corrected</span>
                  </div>
                  {comparisonRows.map((row) => (
                    <div key={row.document} className="report-table-row">
                      <span>{row.document}</span>
                      <strong>{row.initial}</strong>
                      <strong>{row.comparison}</strong>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="report-shell report-shell-note">
                {comparisonReport ? (
                  <div className="report-summary-box">
                    <div className="summary-item">
                      <span>Issues Flagged</span>
                      <strong>{comparisonReport?.summary?.total_issues ?? '—'}</strong>
                    </div>
                    <div className="summary-item">
                      <span>Issues Resolved</span>
                      <strong>{issueDelta === null ? '—' : issueDelta > 0 ? `-${issueDelta}` : `${issueDelta}`}</strong>
                    </div>
                    <div className="summary-item">
                      <span>Overall Score</span>
                      <strong>{comparisonReport?.summary?.overall_score ?? '—'}</strong>
                    </div>
                  </div>
                ) : (
                  <p>Comparison JSON will appear here after the second run.</p>
                )}
              </div>

              <div className="report-card-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!comparisonReport}
                  onClick={() => openReportFile(comparisonReport, 'Comparison Report')}
                >
                  Open report
                </button>
                <button
                  type="button"
                  className="download-button"
                  disabled={!comparisonReport}
                  onClick={() => downloadReportPdf(comparisonReport, 'comparison-report.pdf', 'Comparison Report')}
                >
                  Download report
                </button>
              </div>
            </article>
          </div>
        </section>
      </section>

      {alertOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={closeAlert}>
          <div
            className="modal-card modal-card-warning"
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-title"
            aria-describedby="alert-copy"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="alert-title">{alertTitle}</h3>
            <p id="alert-copy">{alertMessage}</p>
            <div className="modal-actions">
              <button type="button" className="primary-button" onClick={closeAlert}>
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
