// Logic for PDF Editor Page
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes, downloadFile } from '../utils/helpers.js';
import { makeUniqueFileKey } from '../utils/deduplicate-filename.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';

const embedPdfWasmUrl = new URL(
  'embedpdf-snippet/dist/pdfium.wasm',
  import.meta.url
).href;

import type { EmbedPdfContainer } from 'embedpdf-snippet';
import type { DocManagerPlugin } from '@/types';

type PdfRect = {
  origin: { x: number; y: number };
  size: { width: number; height: number };
};

type FormattedSelection = {
  pageIndex: number;
  rect: PdfRect;
  segmentRects: PdfRect[];
};

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let isViewerInitialized = false;
let currentFileName = 'document.pdf';
const fileEntryMap = new Map<string, HTMLElement>();

function resetViewer() {
  const pdfWrapper = document.getElementById('embed-pdf-wrapper');
  const pdfContainer = document.getElementById('embed-pdf-container');
  const downloadBtn = document.getElementById('download-edited-pdf');
  const replacePanel = document.getElementById('replace-selected-text-panel');
  const fileDisplayArea = document.getElementById('file-display-area');
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  if (pdfContainer) pdfContainer.textContent = '';
  if (pdfWrapper) pdfWrapper.classList.add('hidden');
  if (downloadBtn) downloadBtn.classList.add('hidden');
  if (replacePanel) replacePanel.remove();
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  if (fileInput) fileInput.value = '';
  viewerInstance = null;
  docManagerPlugin = null;
  isViewerInitialized = false;
  fileEntryMap.clear();
}

function removeFileEntry(documentId: string) {
  const entry = fileEntryMap.get(documentId);
  if (entry) {
    entry.remove();
    fileEntryMap.delete(documentId);
  }
  if (fileEntryMap.size === 0) {
    resetViewer();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage() {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  if (fileInput) {
    fileInput.addEventListener('change', handleFileUpload);
  }

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-indigo-500');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-indigo-500');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-indigo-500');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFiles(files);
      }
    });

    fileInput?.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
    });
  }

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    await handleFiles(input.files);
  }
}

async function handleFiles(files: FileList) {
  const pdfFiles = Array.from(files).filter(
    (f) => f.type === 'application/pdf'
  );
  if (pdfFiles.length === 0) {
    showAlert('Invalid File', 'Please upload a valid PDF file.');
    return;
  }

  showLoader('Loading PDF Editor...');

  try {
    const pdfWrapper = document.getElementById('embed-pdf-wrapper');
    const pdfContainer = document.getElementById('embed-pdf-container');
    const fileDisplayArea = document.getElementById('file-display-area');

    if (!pdfWrapper || !pdfContainer || !fileDisplayArea) return;

    hideLoader();
    const decryptedFiles = await batchDecryptIfNeeded(pdfFiles);
    showLoader('Loading PDF Editor...');

    if (decryptedFiles.length === 0) {
      hideLoader();
      return;
    }

    if (!isViewerInitialized) {
      const firstFile = decryptedFiles[0];
      currentFileName = firstFile.name;
      const firstBuffer = await firstFile.arrayBuffer();

      pdfContainer.textContent = '';
      pdfWrapper.classList.remove('hidden');

      const { default: EmbedPDF } = await import('embedpdf-snippet');
      const disabledCategories = getEditorDisabledCategories();
      viewerInstance = EmbedPDF.init({
        disabledCategories,
        type: 'container',
        target: pdfContainer,
        worker: true,
        wasmUrl: embedPdfWasmUrl,
        export: {
          defaultFileName: firstFile.name,
        },
        documentManager: {
          maxDocuments: 10,
        },
        tabBar: 'always',
      });

      const registry = await viewerInstance.registry;
      docManagerPlugin = registry
        .getPlugin('document-manager')
        .provides() as unknown as DocManagerPlugin;

      docManagerPlugin.onDocumentClosed((data: { id?: string }) => {
        const docId = data?.id || '';
        removeFileEntry(docId);
      });

      docManagerPlugin.onDocumentOpened(
        (data: { id?: string; name?: string }) => {
          const docId = data?.id;
          const docKey = data?.name;
          if (!docId) return;
          const pendingEntry = fileDisplayArea.querySelector(
            `[data-pending-name="${CSS.escape(docKey)}"]`
          ) as HTMLElement;
          if (pendingEntry) {
            pendingEntry.removeAttribute('data-pending-name');
            fileEntryMap.set(docId, pendingEntry);
            const removeBtn = pendingEntry.querySelector(
              '[data-remove-btn]'
            ) as HTMLElement;
            if (removeBtn) {
              removeBtn.onclick = () => {
                docManagerPlugin.closeDocument(docId);
              };
            }
          }
        }
      );

      addFileEntries(fileDisplayArea, decryptedFiles);

      docManagerPlugin.openDocumentBuffer({
        buffer: firstBuffer,
        name: makeUniqueFileKey(0, firstFile.name),
        autoActivate: true,
      });

      for (let i = 1; i < decryptedFiles.length; i++) {
        const buffer = await decryptedFiles[i].arrayBuffer();
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, decryptedFiles[i].name),
          autoActivate: false,
        });
      }

      isViewerInitialized = true;

      ensureReplaceSelectedTextPanel(pdfWrapper, registry);

      let downloadBtn = document.getElementById('download-edited-pdf');
      if (!downloadBtn) {
        downloadBtn = document.createElement('button');
        downloadBtn.id = 'download-edited-pdf';
        downloadBtn.className = 'btn-gradient w-full mt-4';
        downloadBtn.textContent = 'Download Edited PDF';
        pdfWrapper.appendChild(downloadBtn);
      }
      downloadBtn.classList.remove('hidden');

      downloadBtn.onclick = async () => {
        try {
          const exportPlugin = registry.getPlugin('export').provides();
          const arrayBuffer = await exportPlugin.saveAsCopy().toPromise();
          const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
          downloadFile(blob, currentFileName);
        } catch (err) {
          console.error('Error downloading PDF:', err);
          showAlert('Error', 'Failed to download the edited PDF.');
        }
      };

      const backBtn = document.getElementById('back-to-tools');
      if (backBtn) {
        const newBackBtn = backBtn.cloneNode(true);
        backBtn.parentNode?.replaceChild(newBackBtn, backBtn);

        newBackBtn.addEventListener('click', () => {
          window.location.href = import.meta.env.BASE_URL;
        });
      }
    } else {
      addFileEntries(fileDisplayArea, decryptedFiles);

      for (let i = 0; i < decryptedFiles.length; i++) {
        const buffer = await decryptedFiles[i].arrayBuffer();
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: makeUniqueFileKey(i, decryptedFiles[i].name),
          autoActivate: true,
        });
      }
    }
  } catch (error) {
    console.error('Error loading PDF Editor:', error);
    showAlert('Error', 'Failed to load the PDF Editor.');
  } finally {
    hideLoader();
  }
}

function ensureReplaceSelectedTextPanel(pdfWrapper: HTMLElement, registry: any) {
  if (document.getElementById('replace-selected-text-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'replace-selected-text-panel';
  panel.className =
    'mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg space-y-3';

  const heading = document.createElement('div');
  heading.className = 'flex items-center gap-2';
  heading.innerHTML =
    '<i data-lucide="text-cursor-input" class="w-5 h-5 text-indigo-400"></i><span class="font-semibold text-white">Replace Existing Text <span class="text-xs font-normal text-indigo-300">Beta</span></span>';

  const help = document.createElement('p');
  help.className = 'text-sm text-gray-400';
  help.textContent =
    'Select one line of existing text in the PDF, then replace it. Best for names, dates, amounts, and short labels.';

  const button = document.createElement('button');
  button.id = 'replace-selected-text-btn';
  button.className =
    'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-colors';
  button.textContent = 'Replace Selected Text';
  button.onclick = () => replaceSelectedText(registry);

  panel.append(heading, help, button);
  pdfWrapper.appendChild(panel);
  createIcons({ icons });
}

async function replaceSelectedText(registry: any) {
  const documentManager = docManagerPlugin as unknown as {
    getActiveDocumentId?: () => string | null;
  };
  const documentId = documentManager?.getActiveDocumentId?.();

  if (!documentId) {
    showAlert('No Active PDF', 'Open a PDF before replacing text.');
    return;
  }

  try {
    const selectionCapability = registry.getPlugin('selection').provides() as any;
    const selectionScope = selectionCapability.forDocument(documentId);
    const formattedSelection =
      selectionScope.getFormattedSelection() as FormattedSelection[];

    if (!formattedSelection?.length) {
      showAlert(
        'Select Text First',
        'Drag over one line of existing PDF text, then click Replace Selected Text.'
      );
      return;
    }

    const pageIndexes = new Set(
      formattedSelection.map((selection) => selection.pageIndex)
    );
    const rects = formattedSelection.flatMap(
      (selection) => selection.segmentRects || []
    );

    if (
      pageIndexes.size !== 1 ||
      rects.length === 0 ||
      !isSingleVisualLine(rects)
    ) {
      showAlert(
        'Single-Line Selection Required',
        'This beta editor currently replaces one line of text on one page at a time.'
      );
      return;
    }

    const selectedTextParts = await selectionScope.getSelectedText().toPromise();
    const originalText = (selectedTextParts || [])
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const replacement = window.prompt(
      'Replace selected text with:',
      originalText
    );

    if (replacement === null || replacement === originalText) return;

    const pageIndex = formattedSelection[0].pageIndex;
    const replacementRect = unionRects(rects);

    showLoader('Replacing text...');

    const redactionCapability = registry.getPlugin('redaction').provides() as any;
    const redactionScope = redactionCapability.forDocument(documentId);
    const queued = await redactionScope
      .queueCurrentSelectionAsPending()
      .toPromise();

    if (!queued) {
      throw new Error('Could not queue the selected text for replacement.');
    }

    const redacted = await redactionScope.commitAllPending().toPromise();
    if (!redacted) {
      throw new Error('Could not remove the original selected text.');
    }

    if (replacement.length > 0) {
      const annotationCapability = registry
        .getPlugin('annotation')
        .provides() as any;
      const freeTextTool = annotationCapability.getTool('freeText');

      if (!freeTextTool) {
        throw new Error('The Free Text annotation tool is unavailable.');
      }

      const annotationScope = annotationCapability.forDocument(documentId);
      const annotation = {
        ...freeTextTool.defaults,
        id: createAnnotationId(),
        pageIndex,
        rect: replacementRect,
        contents: replacement,
        fontSize: estimateReplacementFontSize(replacementRect, replacement),
        fontColor: '#000000',
        fontFamily: 'Helvetica',
        backgroundColor: '#FFFFFF',
        opacity: 1,
      };

      annotationScope.createAnnotation(pageIndex, annotation, {
        source: 'programmatic',
      });
      await annotationScope.commit().toPromise();
    }

    selectionScope.clear();
  } catch (error) {
    console.error('Error replacing selected PDF text:', error);
    const message = error instanceof Error ? error.message : String(error);
    showAlert(
      'Replace Text Failed',
      `${message}\n\nTry a shorter, single-line text selection.`
    );
  } finally {
    hideLoader();
  }
}

function unionRects(rects: PdfRect[]): PdfRect {
  const left = Math.min(...rects.map((rect) => rect.origin.x));
  const top = Math.min(...rects.map((rect) => rect.origin.y));
  const right = Math.max(
    ...rects.map((rect) => rect.origin.x + rect.size.width)
  );
  const bottom = Math.max(
    ...rects.map((rect) => rect.origin.y + rect.size.height)
  );

  return {
    origin: { x: left, y: top },
    size: {
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    },
  };
}

function isSingleVisualLine(rects: PdfRect[]): boolean {
  if (rects.length <= 1) return true;

  const heights = rects.map((rect) => Math.max(1, rect.size.height));
  const maxHeight = Math.max(...heights);
  const centers = rects.map(
    (rect) => rect.origin.y + Math.max(1, rect.size.height) / 2
  );
  const verticalSpread = Math.max(...centers) - Math.min(...centers);

  return verticalSpread <= maxHeight * 0.65;
}

function estimateReplacementFontSize(rect: PdfRect, replacement: string): number {
  let fontSize = Math.max(5, Math.min(72, rect.size.height * 0.78));
  if (!replacement) return fontSize;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return fontSize;

  context.font = `${fontSize}px Arial, Helvetica, sans-serif`;
  const measuredWidth = context.measureText(replacement).width;
  const availableWidth = Math.max(1, rect.size.width * 0.96);

  if (measuredWidth > availableWidth) {
    fontSize *= availableWidth / measuredWidth;
  }

  return Math.max(5, Math.min(72, fontSize));
}

function createAnnotationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `replace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addFileEntries(fileDisplayArea: HTMLElement, files: File[]) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileDiv = document.createElement('div');
    fileDiv.className =
      'flex items-center justify-between bg-gray-700 p-3 rounded-lg';
    fileDiv.setAttribute('data-pending-name', makeUniqueFileKey(i, file.name));

    const infoContainer = document.createElement('div');
    infoContainer.className = 'flex flex-col flex-1 min-w-0';

    const nameSpan = document.createElement('div');
    nameSpan.className = 'truncate font-medium text-gray-200 text-sm mb-1';
    nameSpan.textContent = file.name;

    const metaSpan = document.createElement('div');
    metaSpan.className = 'text-xs text-gray-400';
    metaSpan.textContent = formatBytes(file.size);

    infoContainer.append(nameSpan, metaSpan);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
    removeBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>';
    removeBtn.setAttribute('data-remove-btn', 'true');
    removeBtn.onclick = () => {
      fileDiv.remove();
      if (fileDisplayArea.children.length === 0) {
        resetViewer();
      }
    };

    fileDiv.append(infoContainer, removeBtn);
    fileDisplayArea.appendChild(fileDiv);
  }

  createIcons({ icons });
}
