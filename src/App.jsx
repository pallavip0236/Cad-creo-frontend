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
  const [outputFiles, setOutputFiles] = useState(() => loadStorage('creo-output-files-v1', []));
  const [selectedPdfLabel, setSelectedPdfLabel] = useState('');
  const [generated, setGenerated] = useState(false);
  const [generatedAt, setGeneratedAt] = useState('');
  const [versionMap, setVersionMap] = useState(() => loadStorage('creo-version-map-v1', {}));
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [alertMessage, setAlertMessage] = useState('');
  const [alertOpen, setAlertOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const fileInputRef = useRef(null);
  const formatMenuRef = useRef(null);

  const selectedFormatLabel =
    nativeFormats.find((item) => item.value === nativeFormat)?.label ?? nativeFormat;

  const summary = useMemo(() => {
    const totalSize = outputFiles.reduce((acc, file) => acc + file.size, 0);
    return {
      count: outputFiles.length,
      size: formatBytes(totalSize),
    };
  }, [outputFiles]);

  useEffect(() => {
    window.localStorage.setItem('creo-output-files-v1', JSON.stringify(outputFiles));
  }, [outputFiles]);

  useEffect(() => {
    window.localStorage.setItem('creo-version-map-v1', JSON.stringify(versionMap));
  }, [versionMap]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (formatMenuRef.current && !formatMenuRef.current.contains(event.target)) {
        setFormatMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const openAlert = (message) => {
    setAlertMessage(message);
    setAlertOpen(true);
  };

  const closeAlert = () => {
    setAlertOpen(false);
    setAlertMessage('');
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
      setGenerated(false);
      setGeneratedAt('');
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
    setGenerated(false);
    setGeneratedAt('');
    event.target.value = '';
  };

  const openFolderPicker = () => {
    fileInputRef.current?.click();
  };

  const markDownloadTimestamp = (fileId) => {
    const stamp = formatTimestamp(new Date());
    setOutputFiles((current) =>
      current.map((item) => (item.id === fileId ? { ...item, downloadedAt: stamp } : item)),
    );
    return stamp;
  };

  const deleteOutputFile = (fileId) => {
    setOutputFiles((current) => current.filter((item) => item.id !== fileId));
  };

  const downloadFile = (fileEntry) => {
    const href = fileEntry.dataUrl || URL.createObjectURL(fileEntry.file);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileEntry.generatedName || fileEntry.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    if (!fileEntry.dataUrl) {
      URL.revokeObjectURL(href);
    }
    markDownloadTimestamp(fileEntry.id);
  };

  const downloadAllFiles = () => {
    outputFiles.forEach((fileEntry, index) => {
      window.setTimeout(() => downloadFile(fileEntry), index * 250);
    });
  };

  const generateOutput = async () => {
    if (!stagedFiles.length || isGenerating) return;

    setIsGenerating(true);
    try {
      const generationStamp = formatDownloadStamp(new Date());
      const nextVersionMap = { ...versionMap };

      const versionedFiles = await Promise.all(
        stagedFiles.map(async (file) => {
          const fileKey = normalizePdfBaseName(file.name).toLowerCase();

          // Check version embedded in the uploaded filename (handles re-uploaded downloads)
          const embeddedVersion = extractVersionFromName(file.name);

          // Check versions already tracked in outputFiles and versionMap
          const existingVersions = outputFiles
            .filter((item) => normalizePdfBaseName(item.name).toLowerCase() === fileKey)
            .map((item) => item.version || 1);

          const nextVersion =
            Math.max(
              0,
              embeddedVersion,           // version from the uploaded file's own name
              nextVersionMap[fileKey] || 0,
              ...existingVersions,
            ) + 1;

          nextVersionMap[fileKey] = nextVersion;

          const dataUrl = await fileToDataUrl(file.file);
          const displayName = `${normalizePdfBaseName(file.name)}.pdf`;
          return {
            ...file,
            dataUrl,
            version: nextVersion,
            name: displayName,
            path: displayName,
            originalName: file.name,
            generatedName: buildGeneratedFileName(file.name, nextVersion, generationStamp),
            downloadedAt: '',
          };
        }),
      );

      setOutputFiles((current) => [...current, ...versionedFiles]);
      setVersionMap(nextVersionMap);
      setGenerated(true);
      setGeneratedAt(formatTimestamp(new Date()));
    } finally {
      setIsGenerating(false);
    }
  };

  const outputStatus = generated
    ? `Output generated${outputFiles.length ? ` (${outputFiles.length} file${outputFiles.length === 1 ? '' : 's'})` : ''}`
    : stagedFiles.length
      ? 'PDF files selected, ready to generate'
      : 'Waiting for PDF files';

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copyblock">
          <p className="eyebrow">CREO FILE WORKSPACE</p>
          <h1>Choose a native format and inspect the Creo folder output in one place.</h1>
          <p className="hero-copy">
            Select a target native format and drop in a Creo folder. Preview every output file in a
            crisp, real-time list.
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

            <button
              type="button"
              className="generate-button"
              disabled={!stagedFiles.length || isGenerating}
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
              <h2>Files</h2>
            </div>

            <div className="output-actions">
              <div className="output-metrics">
                <div>
                  <span>Total files</span>
                  <strong>{summary.count}</strong>
                </div>

                <div>
                  <span>Total size</span>
                  <strong>{summary.size}</strong>
                </div>


              </div>

              <button
                type="button"
                className="download-button"
                disabled={!outputFiles.length}
                onClick={downloadAllFiles}
              >
                Download all
              </button>
            </div>
          </div>

          {generatedAt ? <div className="generated-stamp">Generated at {generatedAt}</div> : null}

          {outputFiles.length ? (
            <div className="file-list">
              {outputFiles.map((file) => (
                <article key={file.id} className="file-row">
                  <div className="file-main">
                    <strong>{file.name}</strong>
                    <span>{file.path}</span>
                  </div>

                  <div className="file-meta">
                    <span>{file.type}</span>
                    <span>{formatBytes(file.size)}</span>
                    <span>{file.updated}</span>
                    <span>{file.downloadedAt ? `Downloaded ${file.downloadedAt}` : 'Not downloaded yet'}</span>

                    <div className="file-actions">
                      <button type="button" className="row-download" onClick={() => downloadFile(file)}>
                        Download
                      </button>

                      <button
                        type="button"
                        className="row-delete"
                        onClick={() => deleteOutputFile(file.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-illustration">DIR</div>
              <h3>No files loaded yet</h3>
              <p>Choose PDF files and generate output to display the files here.</p>
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
            <h3 id="alert-title">PDF files only</h3>
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
