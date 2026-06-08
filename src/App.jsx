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

function getReportUrl(type, download = false) {
  const params = new URLSearchParams({ type: String(type || 'comparison') });
  if (download) params.set('download', '1');
  return `/api/report?${params.toString()}`;
}

function LoadingSpinner({ label }) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12,padding:'20px 0'}}>
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{animation:'spin .9s linear infinite'}}>
        <circle cx="22" cy="22" r="18" stroke="#e2e8f0" strokeWidth="4"/>
        <path d="M40 22a18 18 0 0 0-18-18" stroke="#6366f1" strokeWidth="4" strokeLinecap="round"/>
        
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

  const openReportFile = async (reportType) => {
    window.open(getReportUrl(reportType), '_blank', 'noopener,noreferrer');
  };

  const downloadPdfDirect = async (reportType) => {
    window.open(getReportUrl(reportType, true), '_blank', 'noopener,noreferrer');
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
                  onClick={() => openReportFile('initial')}>Open report</button>
                <button className="btn-download" disabled={!initialReport}
                  onClick={() => downloadPdfDirect('initial')}>
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
                  onClick={() => openReportFile('comparison')}>Open report</button>
                <button className="btn-download" disabled={!comparisonReport}
                  onClick={() => downloadPdfDirect('comparison')}>
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




