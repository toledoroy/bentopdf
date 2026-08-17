// Logic for PDF Editor Page
import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import { formatBytes } from '../utils/helpers.js';
import { makeUniqueFileKey } from '../utils/deduplicate-filename.js';
import { batchDecryptIfNeeded } from '../utils/password-prompt.js';
import { getEditorDisabledCategories } from '../utils/disabled-tools.js';
import { PdfEditorSession } from './pdf-editor-session.js';
import { installTextEditingPanel } from './pdf-text-editing.js';

const embedPdfWasmUrl = new URL(
  'embedpdf-snippet/dist/pdfium.wasm',
  import.meta.url
).href;

import type { EmbedPdfContainer } from 'embedpdf-snippet';
import type { DocManagerPlugin } from '@/types';

type PreparedPdf = {
  file: File;
  buffer: ArrayBuffer;
  documentKey: string;
};

let viewerInstance: EmbedPdfContainer | null = null;
let docManagerPlugin: DocManagerPlugin | null = null;
let isViewerInitialized = false;
let nextDocumentIndex = 0;
const fileEntryMap = new Map<string, HTMLElement>();
const documentIdByKey = new Map<string, string>();

const activeDocumentId = (): string | null => {
  const manager = docManagerPlugin as unknown as {
    getActiveDocumentId?: () => string | null;
  };
  return manager?.getActiveDocumentId?.() ?? null;
};

const editorSession = new PdfEditorSession(activeDocumentId);

function resetViewer(): void {
  const pdfWrapper = document.getElementById('embed-pdf-wrapper');
  const pdfContainer = document.getElementById('embed-pdf-container');
  const downloadButton = document.getElementById('download-edited-pdf');
  const textPanel = document.getElementById('replace-selected-text-panel');
  const fileDisplayArea = document.getElementById('file-display-area');
  const fileInput = document.getElementById('file-input') as HTMLInputElement;

  if (pdfContainer) pdfContainer.textContent = '';
  if (pdfWrapper) pdfWrapper.classList.add('hidden');
  if (downloadButton) downloadButton.classList.add('hidden');
  if (textPanel) textPanel.remove();
  if (fileDisplayArea) fileDisplayArea.innerHTML = '';
  if (fileInput) fileInput.value = '';

  viewerInstance = null;
  docManagerPlugin = null;
  isViewerInitialized = false;
  nextDocumentIndex = 0;
  fileEntryMap.clear();
  documentIdByKey.clear();
  editorSession.reset();
}

function removeFileEntry(documentId: string): void {
  const entry = fileEntryMap.get(documentId);
  const documentKey = entry?.getAttribute('data-document-key');
  if (entry) entry.remove();
  fileEntryMap.delete(documentId);
  if (documentKey) documentIdByKey.delete(documentKey);
  editorSession.unregisterDocument(documentId);
  if (fileEntryMap.size === 0) resetViewer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePage);
} else {
  initializePage();
}

function initializePage(): void {
  createIcons({ icons });

  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const dropZone = document.getElementById('drop-zone');

  fileInput?.addEventListener('change', handleFileUpload);
  fileInput?.addEventListener('click', () => {
    fileInput.value = '';
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('border-indigo-500');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-indigo-500');
    });
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('border-indigo-500');
      const files = event.dataTransfer?.files;
      if (files?.length) void handleFiles(files);
    });
  }

  document.getElementById('back-to-tools')?.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

async function handleFileUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) await handleFiles(input.files);
}

async function preparePdfFiles(files: File[]): Promise<PreparedPdf[]> {
  const prepared: PreparedPdf[] = [];

  for (const file of files) {
    const documentKey = makeUniqueFileKey(nextDocumentIndex++, file.name);
    const buffer = await file.arrayBuffer();
    editorSession.registerPendingDocument(documentKey, file.name, buffer);
    prepared.push({ file, buffer, documentKey });
  }

  return prepared;
}

async function handleFiles(files: FileList): Promise<void> {
  if (!editorSession.beginOperation('PDF loading')) return;

  let prepared: PreparedPdf[] = [];
  showLoader('Loading PDF Editor...');

  try {
    const pdfFiles = Array.from(files).filter(
      (file) =>
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf')
    );
    if (pdfFiles.length === 0) {
      showAlert('Invalid File', 'Please upload a valid PDF file.');
      return;
    }

    const openOrPendingDocuments = document.querySelectorAll(
      '[data-document-key]'
    ).length;
    const remainingSlots = Math.max(0, 10 - openOrPendingDocuments);
    if (pdfFiles.length > remainingSlots) {
      showAlert(
        'Too Many PDFs',
        'The editor supports at most 10 open PDFs. Close a document before opening more.'
      );
      return;
    }

    const pdfWrapper = document.getElementById('embed-pdf-wrapper');
    const pdfContainer = document.getElementById('embed-pdf-container');
    const fileDisplayArea = document.getElementById('file-display-area');
    if (!pdfWrapper || !pdfContainer || !fileDisplayArea) {
      throw new Error('The PDF editor interface is incomplete.');
    }

    hideLoader();
    const decryptedFiles = await batchDecryptIfNeeded(pdfFiles);
    showLoader('Loading PDF Editor...');
    if (decryptedFiles.length === 0) return;

    prepared = await preparePdfFiles(decryptedFiles);

    if (!isViewerInitialized) {
      pdfContainer.textContent = '';
      pdfWrapper.classList.remove('hidden');

      const { default: EmbedPDF } = await import('embedpdf-snippet');
      viewerInstance = EmbedPDF.init({
        disabledCategories: getEditorDisabledCategories(),
        type: 'container',
        target: pdfContainer,
        worker: true,
        wasmUrl: embedPdfWasmUrl,
        export: { defaultFileName: prepared[0].file.name },
        documentManager: { maxDocuments: 10 },
        redaction: {
          drawBlackBoxes: false,
          useAnnotationMode: false,
        },
        tabBar: 'always',
      });

      const registry = await viewerInstance.registry;
      docManagerPlugin = registry
        .getPlugin('document-manager')
        .provides() as unknown as DocManagerPlugin;

      docManagerPlugin.onDocumentClosed((data: { id?: string }) => {
        removeFileEntry(data?.id ?? '');
      });
      docManagerPlugin.onDocumentOpened(
        (data: { id?: string; name?: string }) => {
          bindOpenedDocument(
            fileDisplayArea,
            data?.id ?? '',
            data?.name ?? ''
          );
        }
      );

      addFileEntries(fileDisplayArea, prepared);
      openPreparedDocuments(prepared, false);

      isViewerInitialized = true;
      installTextEditingPanel(
        pdfWrapper,
        registry,
        editorSession,
        activeDocumentId
      );
      editorSession.installDownloadButton(pdfWrapper, registry);
      replaceBackButton();
    } else {
      if (!docManagerPlugin) {
        throw new Error('The PDF document manager is unavailable.');
      }
      addFileEntries(fileDisplayArea, prepared);
      openPreparedDocuments(prepared, true);
    }
  } catch (error) {
    for (const preparedDocument of prepared) {
      editorSession.removePendingDocument(preparedDocument.documentKey);
      const openedId = documentIdByKey.get(preparedDocument.documentKey);
      if (openedId) {
        docManagerPlugin?.closeDocument(openedId);
      } else {
        globalThis.document
          .querySelector(
            `[data-document-key="${CSS.escape(preparedDocument.documentKey)}"]`
          )
          ?.remove();
      }
    }

    console.error('Error loading PDF Editor:', error);
    const message = error instanceof Error ? error.message : String(error);
    showAlert('Error', `Failed to load the PDF Editor.\n\n${message}`);
  } finally {
    hideLoader();
    editorSession.endOperation();
  }
}

function bindOpenedDocument(
  fileDisplayArea: HTMLElement,
  documentId: string,
  documentKey: string
): void {
  if (!documentId || !documentKey) return;

  const pendingEntry = fileDisplayArea.querySelector(
    `[data-pending-name="${CSS.escape(documentKey)}"]`
  ) as HTMLElement | null;

  if (pendingEntry) {
    pendingEntry.removeAttribute('data-pending-name');
    fileEntryMap.set(documentId, pendingEntry);
    documentIdByKey.set(documentKey, documentId);

    const removeButton = pendingEntry.querySelector(
      '[data-remove-btn]'
    ) as HTMLButtonElement | null;
    if (removeButton) {
      removeButton.onclick = () => {
        docManagerPlugin?.closeDocument(documentId);
      };
    }
  }

  editorSession.bindOpenedDocument(documentId, documentKey);
}

function openPreparedDocuments(
  prepared: PreparedPdf[],
  activateLast: boolean
): void {
  if (!docManagerPlugin) {
    throw new Error('The PDF document manager is unavailable.');
  }

  for (let index = 0; index < prepared.length; index++) {
    const document = prepared[index];
    docManagerPlugin.openDocumentBuffer({
      buffer: document.buffer,
      name: document.documentKey,
      autoActivate: activateLast
        ? index === prepared.length - 1
        : index === 0,
    });
  }
}

function replaceBackButton(): void {
  const backButton = document.getElementById('back-to-tools');
  if (!backButton) return;

  const replacement = backButton.cloneNode(true);
  backButton.parentNode?.replaceChild(replacement, backButton);
  replacement.addEventListener('click', () => {
    window.location.href = import.meta.env.BASE_URL;
  });
}

function addFileEntries(
  fileDisplayArea: HTMLElement,
  files: PreparedPdf[]
): void {
  for (const prepared of files) {
    const fileDiv = document.createElement('div');
    fileDiv.className =
      'flex items-center justify-between bg-gray-700 p-3 rounded-lg';
    fileDiv.setAttribute('data-pending-name', prepared.documentKey);
    fileDiv.setAttribute('data-document-key', prepared.documentKey);

    const infoContainer = document.createElement('div');
    infoContainer.className = 'flex flex-col flex-1 min-w-0';

    const name = document.createElement('div');
    name.className =
      'truncate font-medium text-gray-200 text-sm mb-1';
    name.textContent = prepared.file.name;

    const size = document.createElement('div');
    size.className = 'text-xs text-gray-400';
    size.textContent = formatBytes(prepared.file.size);
    infoContainer.append(name, size);

    const removeButton = document.createElement('button');
    removeButton.className =
      'ml-4 text-red-400 hover:text-red-300 flex-shrink-0';
    removeButton.innerHTML =
      '<i data-lucide="trash-2" class="w-4 h-4"></i>';
    removeButton.setAttribute('data-remove-btn', 'true');
    removeButton.onclick = () => {
      fileDiv.remove();
      editorSession.removePendingDocument(prepared.documentKey);
      if (fileDisplayArea.children.length === 0) resetViewer();
    };

    fileDiv.append(infoContainer, removeButton);
    fileDisplayArea.appendChild(fileDiv);
  }

  createIcons({ icons });
}
