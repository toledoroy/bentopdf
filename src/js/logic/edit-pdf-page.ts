// Logic for PDF Editor Page
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes, downloadFile } from '../utils/helpers.js';
import { makeUniqueFileKey } from '../utils/deduplicate-filename.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';
import {
  createPdfPreservationSnapshot,
  verifyPdfPreservation,
  type PdfPreservationSnapshot,
} from '../utils/pdf-preservation-guard.js';

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

type CurrentTextSelection = {
  documentId: string;
  selectionScope: any;
  formattedSelection: FormattedSelection[];
};

type DocumentMutationState = {
  touchedPages: Set<number>;
  annotationPages: Set<number>;
};

const DEFAULT_TRANSPARENT_EDITING = true;

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let isViewerInitialized = false;
let currentFileName = 'document.pdf';
const fileEntryMap = new Map<string, HTMLElement>();
const documentFileNameMap = new Map<string, string>();
const pendingBaselineMap = new Map<string, Promise<PdfPreservationSnapshot>>();
const baselineMap = new Map<string, Promise<PdfPreservationSnapshot>>();
const mutationStateMap = new Map<string, DocumentMutationState>();

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
  documentFileNameMap.clear();
  pendingBaselineMap.clear();
  baselineMap.clear();
  mutationStateMap.clear();
}

function removeFileEntry(documentId: string) {
  const entry = fileEntryMap.get(documentId);
  if (entry) {
    entry.remove();
    fileEntryMap.delete(documentId);
  }
  documentFileNameMap.delete(documentId);
  baselineMap.delete(documentId);
  mutationStateMap.delete(documentId);
  if (fileEntryMap.size === 0) {
    resetViewer();
  }
}

function getMutationState(documentId: string): DocumentMutationState {
  let state = mutationStateMap.get(documentId);
  if (!state) {
    state = {
      touchedPages: new Set<number>(),
      annotationPages: new Set<number>(),
    };
    mutationStateMap.set(documentId, state);
  }
  return state;
}

function recordTouchedPages(
  documentId: string,
  formattedSelection: FormattedSelection[]
) {
  const state = getMutationState(documentId);
  for (const selection of formattedSelection) {
    state.touchedPages.add(selection.pageIndex);
  }
}

function queuePreservationBaseline(documentKey: string, buffer: ArrayBuffer) {
  pendingBaselineMap.set(
    documentKey,
    createPdfPreservationSnapshot(buffer).catch((error) => {
      console.error('Failed to create PDF preservation baseline:', error);
      throw error;
    })
  );
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
        redaction: {
          drawBlackBoxes: !DEFAULT_TRANSPARENT_EDITING,
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
          if (!docId || !docKey) return;
          const pendingEntry = fileDisplayArea.querySelector(
            `[data-pending-name="${CSS.escape(docKey)}"]`
          ) as HTMLElement;
          if (pendingEntry) {
            pendingEntry.removeAttribute('data-pending-name');
            fileEntryMap.set(docId, pendingEntry);
            const originalName = pendingEntry.getAttribute('data-file-name');
            if (originalName) {
              documentFileNameMap.set(docId, originalName);
            }
            const removeBtn = pendingEntry.querySelector(
              '[data-remove-btn]'
            ) as HTMLElement;
            if (removeBtn) {
              removeBtn.onclick = () => {
                docManagerPlugin?.closeDocument(docId);
              };
            }
          }

          const baseline = pendingBaselineMap.get(docKey);
          if (baseline) {
            baselineMap.set(docId, baseline);
            pendingBaselineMap.delete(docKey);
          }
          getMutationState(docId);
        }
      );

      addFileEntries(fileDisplayArea, decryptedFiles);

      const firstDocumentKey = makeUniqueFileKey(0, firstFile.name);
      queuePreservationBaseline(firstDocumentKey, firstBuffer);
      docManagerPlugin.openDocumentBuffer({
        buffer: firstBuffer,
        name: firstDocumentKey,
        autoActivate: true,
      });

      for (let i = 1; i < decryptedFiles.length; i++) {
        const buffer = await decryptedFiles[i].arrayBuffer();
        const documentKey = makeUniqueFileKey(i, decryptedFiles[i].name);
        queuePreservationBaseline(documentKey, buffer);
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: documentKey,
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
        showLoader('Verifying preservation before download...');
        try {
          const documentManager = docManagerPlugin as unknown as {
            getActiveDocumentId?: () => string | null;
          };
          const documentId = documentManager?.getActiveDocumentId?.();
          if (!documentId) {
            throw new Error('No active PDF is available to verify.');
          }

          const baselinePromise = baselineMap.get(documentId);
          if (!baselinePromise) {
            throw new Error(
              'The preservation baseline is missing, so this save cannot be verified safely.'
            );
          }

          const exportPlugin = registry.getPlugin('export').provides();
          const arrayBuffer = await exportPlugin.saveAsCopy().toPromise();
          const baseline = await baselinePromise;
          const state = getMutationState(documentId);
          const violations = await verifyPdfPreservation(arrayBuffer, baseline, {
            touchedPages: Array.from(state.touchedPages),
            annotationPages: Array.from(state.annotationPages),
            strictPageScope: state.touchedPages.size > 0,
          });

          if (violations.length > 0) {
            console.error('Preservation guard blocked PDF save:', violations);
            showAlert(
              'Preservation Check Blocked Save',
              `The PDF engine changed protected content or document properties that were not authorized, so the file was not downloaded.\n\n${violations
                .slice(0, 10)
                .map((violation) => `• ${violation}`)
                .join('\n')}${
                violations.length > 10
                  ? `\n• …and ${violations.length - 10} more change(s).`
                  : ''
              }`
            );
            return;
          }

          const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
          downloadFile(
            blob,
            documentFileNameMap.get(documentId) ?? currentFileName
          );
        } catch (err) {
          console.error('Error downloading PDF:', err);
          const message = err instanceof Error ? err.message : String(err);
          showAlert(
            'Preservation Verification Failed',
            `The file was not downloaded because BentoPDF could not prove that protected PDF properties were preserved.\n\n${message}`
          );
        } finally {
          hideLoader();
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
        const documentKey = makeUniqueFileKey(i, decryptedFiles[i].name);
        queuePreservationBaseline(documentKey, buffer);
        docManagerPlugin.openDocumentBuffer({
          buffer,
          name: documentKey,
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
    '<i data-lucide="eraser" class="w-5 h-5 text-indigo-400"></i><span class="font-semibold text-white">Remove / Replace Existing Text <span class="text-xs font-normal text-indigo-300">Beta</span></span>';

  const help = document.createElement('p');
  help.className = 'text-sm text-gray-400';
  help.textContent =
    'Select one or more lines of existing PDF text. Removal is destructive and transparent by default: no cover box, fill, or background is added. Downloads are blocked if protected metadata or unrelated pages change.';

  const removeButton = document.createElement('button');
  removeButton.id = 'remove-selected-text-btn';
  removeButton.className =
    'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-colors';
  removeButton.textContent = 'Remove Selected Text';
  removeButton.onclick = () => removeSelectedText(registry);

  const replaceButton = document.createElement('button');
  replaceButton.id = 'replace-selected-text-btn';
  replaceButton.className =
    'w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-2.5 px-4 rounded-lg transition-colors';
  replaceButton.textContent = 'Replace Selected Text';
  replaceButton.onclick = () => replaceSelectedText(registry);

  panel.append(heading, help, removeButton, replaceButton);
  pdfWrapper.appendChild(panel);
  createIcons({ icons });
}

function getCurrentTextSelection(registry: any): CurrentTextSelection | null {
  const documentManager = docManagerPlugin as unknown as {
    getActiveDocumentId?: () => string | null;
  };
  const documentId = documentManager?.getActiveDocumentId?.();

  if (!documentId) {
    showAlert('No Active PDF', 'Open a PDF before editing text.');
    return null;
  }

  const selectionCapability = registry.getPlugin('selection').provides() as any;
  const selectionScope = selectionCapability.forDocument(documentId);
  const formattedSelection =
    selectionScope.getFormattedSelection() as FormattedSelection[];

  if (!formattedSelection?.length) {
    showAlert(
      'Select Text First',
      'Drag over the existing PDF text you want to remove or replace.'
    );
    return null;
  }

  return { documentId, selectionScope, formattedSelection };
}

async function permanentlyRemoveCurrentSelection(
  registry: any,
  documentId: string
): Promise<void> {
  const redactionCapability = registry.getPlugin('redaction').provides() as any;
  const redactionScope = redactionCapability.forDocument(documentId);
  const queued = await redactionScope
    .queueCurrentSelectionAsPending()
    .toPromise();

  if (!queued) {
    throw new Error('Could not queue the selected text for removal.');
  }

  const redacted = await redactionScope.commitAllPending().toPromise();
  if (!redacted) {
    throw new Error('Could not remove the selected text.');
  }
}

async function removeSelectedText(registry: any) {
  const current = getCurrentTextSelection(registry);
  if (!current) return;

  showLoader('Removing selected text...');

  try {
    await permanentlyRemoveCurrentSelection(registry, current.documentId);
    recordTouchedPages(current.documentId, current.formattedSelection);
  } catch (error) {
    console.error('Error removing selected PDF text:', error);
    const message = error instanceof Error ? error.message : String(error);
    showAlert('Remove Text Failed', message);
  } finally {
    hideLoader();
  }
}

async function replaceSelectedText(registry: any) {
  const current = getCurrentTextSelection(registry);
  if (!current) return;

  const { documentId, selectionScope, formattedSelection } = current;
  const pageIndexes = new Set(
    formattedSelection.map((selection) => selection.pageIndex)
  );
  const rects = formattedSelection.flatMap(
    (selection) => selection.segmentRects || []
  );

  if (pageIndexes.size !== 1 || rects.length === 0) {
    showAlert(
      'One-Page Block Required',
      'Replacement supports multi-line text blocks, but the selected block must be on one page. Use Remove Selected Text for multi-page selections.'
    );
    return;
  }

  try {
    const selectedTextParts = await selectionScope.getSelectedText().toPromise();
    const originalText = (selectedTextParts || []).join('\n').trim();
    const replacement = window.prompt(
      'Replace the selected text block with:',
      originalText
    );

    if (replacement === null || replacement === originalText) return;

    const pageIndex = formattedSelection[0].pageIndex;
    const replacementRect = unionRects(rects);

    showLoader('Replacing selected text...');
    await permanentlyRemoveCurrentSelection(registry, documentId);
    recordTouchedPages(documentId, formattedSelection);

    if (replacement.length > 0) {
      const annotationCapability = registry
        .getPlugin('annotation')
        .provides() as any;
      const freeTextTool = annotationCapability.getTool('freeText');

      if (!freeTextTool) {
        throw new Error('The Free Text annotation tool is unavailable.');
      }

      const annotationScope = annotationCapability.forDocument(documentId);
      const annotation: any = {
        ...freeTextTool.defaults,
        id: createAnnotationId(),
        pageIndex,
        rect: replacementRect,
        contents: replacement,
        fontSize: estimateReplacementFontSize(replacementRect, replacement),
      };

      if (DEFAULT_TRANSPARENT_EDITING) {
        delete annotation.backgroundColor;
        delete annotation.fillColor;
        delete annotation.borderColor;
        annotation.borderWidth = 0;
      }

      annotationScope.createAnnotation(pageIndex, annotation);
      await annotationScope.commit().toPromise();
      getMutationState(documentId).annotationPages.add(pageIndex);
    }
  } catch (error) {
    console.error('Error replacing selected PDF text:', error);
    const message = error instanceof Error ? error.message : String(error);
    showAlert(
      'Replace Text Failed',
      `${message}\n\nRemoval is the more reliable operation for complex PDF text blocks.`
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

function estimateReplacementFontSize(rect: PdfRect, replacement: string): number {
  const lines = replacement.split(/\r?\n/);
  const lineCount = Math.max(1, lines.length);
  let fontSize = Math.max(
    5,
    Math.min(72, (rect.size.height / lineCount) * 0.78)
  );
  if (!replacement) return fontSize;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return fontSize;

  context.font = `${fontSize}px Arial, Helvetica, sans-serif`;
  const measuredWidth = Math.max(
    ...lines.map((line) => context.measureText(line || ' ').width)
  );
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
    fileDiv.setAttribute('data-file-name', file.name);

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
