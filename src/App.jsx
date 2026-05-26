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
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatDownloadStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function isPdfFile(file) {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return name.endsWith('.pdf') || type === 'application/pdf';
}

/**
 * Strips ALL trailing _vN_<timestamp>Z segments (handles re-uploaded downloaded files
 * that have accumulated multiple version+stamp suffixes).
 * e.g. "Aadharcard_v1_20260515T145501Z_20260515T145505Z" → "Aadharcard"
 */
function normalizePdfBaseName(name) {
  // Remove file extension first
  let base = name.replace(/\.[^.]+$/, '');
  // Repeatedly strip _vN_<timestamp>Z or bare _<timestamp>Z suffixes until nothing changes
  const versionStampPattern = /_v\d+_\d{8}T\d{6}Z/gi;
  const bareStampPattern = /_\d{8}T\d{6}Z/gi;
  let prev;
  do {
    prev = base;
    base = base.replace(versionStampPattern, '');
    base = base.replace(bareStampPattern, '');
  } while (base !== prev);
  return base;
}

/**
 * Extract the highest version number embedded in a filename, if any.
 * e.g. "Aadharcard_v1_20260515T145501Z_20260515T145505Z.pdf" → 1
 * Returns 0 if none found.
 */
function extractVersionFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const matches = [...base.matchAll(/_v(\d+)_\d{8}T\d{6}Z/gi)];
  if (!matches.length) return 0;
  return Math.max(...matches.map((m) => parseInt(m[1], 10)));
}

function buildGeneratedFileName(originalName, version, stamp) {
  const extension = originalName.includes('.') ? `.${originalName.split('.').pop()}` : '.pdf';
  const base = normalizePdfBaseName(originalName);
  return `${base}_v${version}_${stamp}${extension}`;
}

function loadStorage(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [nativeFormat, setNativeFormat] = useState(nativeFormats[0].value);
  const [stagedFiles, setStagedFiles] = useState([]);
  const [creoPdfFiles, setCreoPdfFiles] = useState([]);
  const [selectedPdfLabel, setSelectedPdfLabel] = useState('');
  const [selectedCreoPdfLabel, setSelectedCreoPdfLabel] = useState('');
  const [generatedAt, setGeneratedAt] = useState('');
  const [reportUrl, setReportUrl] = useState('');
  const [reportStatus, setReportStatus] = useState('Waiting for PDF files');
  const [reportError, setReportError] = useState('');
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [alertTitle, setAlertTitle] = useState('PDF files only');
  const [alertOpen, setAlertOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const fileInputRef = useRef(null);
  const creoPdfInputRef = useRef(null);
  const formatMenuRef = useRef(null);

  const selectedFormatLabel =
    nativeFormats.find((item) => item.value === nativeFormat)?.label ?? nativeFormat;

  const summary = useMemo(() => {
    return {
      referenceCount: stagedFiles.length,
      creoCount: creoPdfFiles.length,
      size: formatBytes([...stagedFiles, ...creoPdfFiles].reduce((acc, file) => acc + file.size, 0)),
    };
  }, [stagedFiles, creoPdfFiles]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(event.target)) {
        setFormatMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const openAlert = (message, title = 'PDF files only') => {
    setAlertMessage(message);
    setAlertTitle(title);
    setAlertOpen(true);
  };

  const closeAlert = () => {
    setAlertOpen(false);
    setAlertMessage('');
    setAlertTitle('PDF files only');
  };

  const handleCreoFolder = (event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) {
      event.target.value = '';
      return;
    }

    const invalidFile = files.find((file) => !isPdfFile(file));
    if (invalidFile) {
      setSelectedPdfLabel('');
      setStagedFiles([]);
      setGeneratedAt('');
      setReportUrl('');
      setReportError('');
      setReportStatus('Waiting for PDF files');
      openAlert('Only PDF files are allowed. Please select PDF files only.');
      event.target.value = '';
      return;
    }

    const fileLabel = files.length === 1 ? files[0].name : `${files.length} PDF files selected`;
    const enriched = files.map((file) => ({
      file,
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      path: file.name,
      size: file.size,
      type: file.type || 'application/pdf',
      updated: new Date(file.lastModified).toLocaleDateString(),
      downloadedAt: '',
    }));

    setSelectedPdfLabel(fileLabel);
    setStagedFiles(enriched);
    setGeneratedAt('');
    setReportUrl('');
    setReportError('');
    setReportStatus('PDF files selected, ready to generate');
    event.target.value = '';
  };

  const handleCreoPdfFiles = (event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) {
      event.target.value = '';
      return;
    }

    const invalidFile = files.find((file) => !isPdfFile(file));
    if (invalidFile) {
      setSelectedCreoPdfLabel('');
      setCreoPdfFiles([]);
      setGeneratedAt('');
      setReportUrl('');
      setReportError('');
      setReportStatus('Waiting for PDF files');
      openAlert('Only PDF files are allowed. Please select PDF files only.');
      event.target.value = '';
      return;
    }

    const fileLabel = files.length === 1 ? files[0].name : `${files.length} PDF files selected`;
    const enriched = files.map((file) => ({
      file,
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      path: file.name,
      size: file.size,
      type: file.type || 'application/pdf',
      updated: new Date(file.lastModified).toLocaleDateString(),
      downloadedAt: '',
    }));

    setSelectedCreoPdfLabel(fileLabel);
    setCreoPdfFiles(enriched);
    setGeneratedAt('');
    setReportUrl('');
    setReportError('');
    setReportStatus('PDF files selected, ready to generate');
    event.target.value = '';
  };

  const openFolderPicker = () => {
    fileInputRef.current?.click();
  };

  const openCreoPdfPicker = () => {
    creoPdfInputRef.current?.click();
  };

  const openReport = () => {
    if (reportUrl) {
      window.open(reportUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const generateOutput = async () => {
    if (!stagedFiles.length || !creoPdfFiles.length || isGenerating) {
      openAlert('Please select PDF files for both panels before generating the report.');
      return;
    }

    setIsGenerating(true);
    setReportError('');
    setReportStatus('Sending files to the analyzer...');
    try {
      const referenceFiles = await Promise.all(
        stagedFiles.map(async (file) => ({
          name: file.name,
          dataUrl: await fileToDataUrl(file.file),
        })),
      );
      const reviewFiles = await Promise.all(
        creoPdfFiles.map(async (file) => ({
          name: file.name,
          dataUrl: await fileToDataUrl(file.file),
        })),
      );

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ referenceFiles, reviewFiles }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'Failed to generate the report.');
      }

      setReportUrl(result.reportUrl || `/report.html?ts=${Date.now()}`);
      setGeneratedAt(formatTimestamp(new Date()));
      setReportStatus('Report generated successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Analyzer execution failed.';
      setReportError(message);
      setReportStatus(message);
      openAlert(message, 'Analysis error');
    } finally {
      setIsGenerating(false);
    }
  };

  const outputStatus = reportError
    ? reportError
    : reportUrl
      ? reportStatus
      : stagedFiles.length || creoPdfFiles.length
        ? reportStatus
        : 'Waiting for PDF files';

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copyblock">
          <p className="eyebrow">CREO FILE WORKSPACE</p>
          <h1>Choose a native format and inspect the Creo folder output in one place.</h1>
          <p className="hero-copy">
            Select a target native format and upload reference and Creo PDFs. Preview the generated
            report in a crisp, real-time pane.
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
              <h2>Configure source</h2>
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

          <div className="field-group">
            <label htmlFor="creo-folder">PDF files</label>

            <button type="button" className="folder-picker folder-card" onClick={openFolderPicker}>
              {selectedPdfLabel ? (
                <div className="folder-copy folder-copy-selected">
                  <span className="folder-icon folder-icon-selected">PDF</span>
                  <strong>{selectedPdfLabel}</strong>
                  <span>{`${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'} detected`}</span>
                </div>
              ) : (
                <div className="folder-copy folder-copy-empty">
                  <span className="folder-icon">^</span>
                  <strong>Click to select PDF files</strong>
                  <span>No PDF files selected yet</span>
                </div>
              )}
            </button>

            <input
              id="creo-folder"
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              accept=".pdf,application/pdf"
              onChange={handleCreoFolder}
            />

            <label htmlFor="creo-pdf-files">Creo PDF files</label>
            <button type="button" className="folder-picker folder-card" onClick={openCreoPdfPicker}>
              {selectedCreoPdfLabel ? (
                <div className="folder-copy folder-copy-selected">
                  <span className="folder-icon folder-icon-selected">PDF</span>
                  <strong>{selectedCreoPdfLabel}</strong>
                  <span>{`${creoPdfFiles.length} file${creoPdfFiles.length === 1 ? '' : 's'} detected`}</span>
                </div>
              ) : (
                <div className="folder-copy folder-copy-empty">
                  <span className="folder-icon">^</span>
                  <strong>Click to select Creo PDF files</strong>
                  <span>No Creo PDF files selected yet</span>
                </div>
              )}
            </button>

            <input
              id="creo-pdf-files"
              ref={creoPdfInputRef}
              className="sr-only"
              type="file"
              multiple
              accept=".pdf,application/pdf"
              onChange={handleCreoPdfFiles}
            />

            <button
              type="button"
              className="generate-button"
              disabled={(!stagedFiles.length && !creoPdfFiles.length) || isGenerating}
              onClick={generateOutput}
            >
              {isGenerating ? 'Generating...' : (
                <>
                  Generate output <span>{'->'}</span>
                </>
              )}
            </button>
          </div>

          <div className="info-card">
            <span>Selected format</span>
            <strong>{selectedFormatLabel}</strong>
          </div>

          <div className="info-card">
            <span>Status</span>
            <strong>{outputStatus}</strong>
          </div>
        </aside>

        <section className="panel panel-output">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Output</p>
              <h2>Report</h2>
            </div>

            <div className="output-actions">
              <div className="output-metrics">
                <div>
                  <span>Reference PDFs</span>
                  <strong>{summary.referenceCount}</strong>
                </div>

                <div>
                  <span>Creo PDFs</span>
                  <strong>{summary.creoCount}</strong>
                </div>

                <div>
                  <span>Total size</span>
                  <strong>{summary.size}</strong>
                </div>
              </div>

              <button
                type="button"
                className="download-button"
                disabled={!reportUrl}
                onClick={openReport}
              >
                Open report
              </button>
            </div>
          </div>

          {generatedAt ? <div className="generated-stamp">Generated at {generatedAt}</div> : null}

          {reportUrl ? (
            <div className="report-shell">
              <iframe className="report-frame" title="Creo analysis report" src={reportUrl} />
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-illustration">DIR</div>
              <h3>No report generated yet</h3>
              <p>Choose PDF files in both panels and click Generate output to display report.html here.</p>
            </div>
          )}
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
