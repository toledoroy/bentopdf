import { showAlert, showLoader, hideLoader } from '../ui.js';
import { downloadFile } from '../utils/helpers.js';
import {
  createPdfPreservationSnapshot,
  verifyPdfPreservation,
  type PdfPreservationSnapshot,
} from '../utils/pdf-preservation-guard.js';

export type PdfRect = {
  origin: { x: number; y: number };
  size: { width: number; height: number };
};

export type FormattedSelection = {
  pageIndex: number;
  rect: PdfRect;
  segmentRects: PdfRect[];
};

type MutationState = {
  touchedPages: Set<number>;
  annotationAdditions: Map<number, number>;
  unsafeReason: string | null;
};

type PendingBaseline = {
  fileName: string;
  baseline: Promise<PdfPreservationSnapshot>;
};

export class PdfEditorSession {
  private activeOperation: string | null = null;
  private readonly pendingBaselines = new Map<string, PendingBaseline>();
  private readonly baselines = new Map<
    string,
    Promise<PdfPreservationSnapshot>
  >();
  private readonly fileNames = new Map<string, string>();
  private readonly mutations = new Map<string, MutationState>();

  constructor(private readonly activeDocumentId: () => string | null) {}

  reset(): void {
    this.activeOperation = null;
    this.pendingBaselines.clear();
    this.baselines.clear();
    this.fileNames.clear();
    this.mutations.clear();
    this.setOperationControlsDisabled(false);
  }

  registerPendingDocument(
    documentKey: string,
    fileName: string,
    buffer: ArrayBuffer
  ): void {
    const baseline = createPdfPreservationSnapshot(buffer);
    void baseline.catch((error: unknown) => {
      console.error('Failed to create PDF preservation baseline:', error);
    });
    this.pendingBaselines.set(documentKey, { fileName, baseline });
  }

  removePendingDocument(documentKey: string): void {
    this.pendingBaselines.delete(documentKey);
  }

  bindOpenedDocument(documentId: string, documentKey: string): void {
    const pending = this.pendingBaselines.get(documentKey);
    if (pending) {
      this.fileNames.set(documentId, pending.fileName);
      this.baselines.set(documentId, pending.baseline);
      this.pendingBaselines.delete(documentKey);
    }
    this.getMutationState(documentId);
  }

  unregisterDocument(documentId: string): void {
    this.fileNames.delete(documentId);
    this.baselines.delete(documentId);
    this.mutations.delete(documentId);
  }

  beginOperation(name: string): boolean {
    if (this.activeOperation) {
      showAlert(
        'Operation Already Running',
        `Finish the current ${this.activeOperation} operation before starting another one.`
      );
      return false;
    }

    this.activeOperation = name;
    this.setOperationControlsDisabled(true);
    return true;
  }

  endOperation(): void {
    this.activeOperation = null;
    this.setOperationControlsDisabled(false);
  }

  assertDocumentStillActive(documentId: string): void {
    if (this.activeDocumentId() !== documentId) {
      throw new Error(
        'The active PDF changed while the operation was being prepared.'
      );
    }
  }

  async requireSafeMutationBaseline(
    documentId: string
  ): Promise<PdfPreservationSnapshot> {
    const state = this.getMutationState(documentId);
    if (state.unsafeReason) {
      throw new Error(
        `This in-memory PDF is blocked after an uncertain operation. Reload the original PDF before continuing.\n\n${state.unsafeReason}`
      );
    }

    const baselinePromise = this.baselines.get(documentId);
    if (!baselinePromise) {
      throw new Error(
        'The preservation baseline is missing, so this PDF cannot be edited safely.'
      );
    }

    const baseline = await baselinePromise;
    if (baseline.signedSignatures > 0) {
      throw new Error(
        'This PDF contains a completed digital signature. Text removal or replacement would invalidate the signature, so the operation was blocked.'
      );
    }

    return baseline;
  }

  recordTouchedPages(
    documentId: string,
    formattedSelection: FormattedSelection[]
  ): void {
    const state = this.getMutationState(documentId);
    for (const selection of formattedSelection) {
      state.touchedPages.add(selection.pageIndex);
    }
  }

  recordAnnotationAddition(documentId: string, pageIndex: number): void {
    const state = this.getMutationState(documentId);
    state.annotationAdditions.set(
      pageIndex,
      (state.annotationAdditions.get(pageIndex) ?? 0) + 1
    );
  }

  markUnsafe(documentId: string, reason: string): void {
    const state = this.getMutationState(documentId);
    if (!state.unsafeReason) state.unsafeReason = reason;
  }

  installDownloadButton(pdfWrapper: HTMLElement, registry: any): void {
    let button = document.getElementById(
      'download-edited-pdf'
    ) as HTMLButtonElement | null;

    if (!button) {
      button = document.createElement('button');
      button.id = 'download-edited-pdf';
      button.className = 'btn-gradient w-full mt-4';
      button.textContent = 'Download Edited PDF';
      pdfWrapper.appendChild(button);
    }

    button.classList.remove('hidden');
    button.onclick = () => {
      void this.downloadVerifiedPdf(registry);
    };
  }

  private getMutationState(documentId: string): MutationState {
    let state = this.mutations.get(documentId);
    if (!state) {
      state = {
        touchedPages: new Set<number>(),
        annotationAdditions: new Map<number, number>(),
        unsafeReason: null,
      };
      this.mutations.set(documentId, state);
    }
    return state;
  }

  private mutationPolicy(documentId: string) {
    const state = this.getMutationState(documentId);
    return {
      touchedPages: Array.from(state.touchedPages),
      annotationAdditions: Object.fromEntries(
        state.annotationAdditions.entries()
      ),
      // Verified export only authorizes edits made through the tracked
      // removal/replacement workflow. Unknown viewer mutations fail closed.
      strictPageScope: true,
    };
  }

  private setOperationControlsDisabled(disabled: boolean): void {
    const controls = new Set<HTMLElement>();

    for (const id of [
      'remove-selected-text-btn',
      'replace-selected-text-btn',
      'download-edited-pdf',
      'file-input',
    ]) {
      const element = document.getElementById(id) as HTMLElement | null;
      if (element) controls.add(element);
    }

    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-remove-btn]'
    )) {
      controls.add(element);
    }

    for (const element of controls) {
      if ('disabled' in element) {
        (element as HTMLButtonElement | HTMLInputElement).disabled = disabled;
      }
      element.setAttribute('aria-disabled', String(disabled));
      element.classList.toggle('opacity-50', disabled);
      element.classList.toggle('cursor-not-allowed', disabled);
    }
  }

  private async downloadVerifiedPdf(registry: any): Promise<void> {
    if (!this.beginOperation('download')) return;
    showLoader('Verifying preservation before download...');

    try {
      const documentId = this.activeDocumentId();
      if (!documentId) {
        throw new Error('No active PDF is available to verify.');
      }

      const state = this.getMutationState(documentId);
      if (state.unsafeReason) {
        throw new Error(
          `This in-memory PDF entered an uncertain state after an operation failed. Reload the original PDF before continuing.\n\n${state.unsafeReason}`
        );
      }

      const baselinePromise = this.baselines.get(documentId);
      if (!baselinePromise) {
        throw new Error(
          'The preservation baseline is missing, so this save cannot be verified safely.'
        );
      }

      const exportPlugin = registry.getPlugin('export').provides();
      const arrayBuffer = await exportPlugin.saveAsCopy().toPromise();
      this.assertDocumentStillActive(documentId);
      const baseline = await baselinePromise;
      const violations = await verifyPdfPreservation(
        arrayBuffer,
        baseline,
        this.mutationPolicy(documentId)
      );

      this.assertDocumentStillActive(documentId);

      if (violations.length > 0) {
        console.error('Preservation guard blocked PDF save:', violations);
        showAlert(
          'Preservation Check Blocked Save',
          `The PDF engine changed protected content or document properties that were not authorized, so the file was not downloaded.\n\n${violations
            .slice(0, 10)
            .map((violation: string) => `• ${violation}`)
            .join('\n')}${
            violations.length > 10
              ? `\n• …and ${violations.length - 10} more change(s).`
              : ''
          }`
        );
        return;
      }

      this.assertDocumentStillActive(documentId);
      downloadFile(
        new Blob([arrayBuffer], { type: 'application/pdf' }),
        this.fileNames.get(documentId) ?? 'document.pdf'
      );
    } catch (error) {
      console.error('Error downloading PDF:', error);
      const message = error instanceof Error ? error.message : String(error);
      showAlert(
        'Preservation Verification Failed',
        `The file was not downloaded because BentoPDF could not prove that protected PDF properties were preserved.\n\n${message}`
      );
    } finally {
      hideLoader();
      this.endOperation();
    }
  }
}
