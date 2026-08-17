import { createIcons, icons } from 'lucide';
import { showAlert, showLoader, hideLoader } from '../ui.js';
import {
  PdfEditorSession,
  type FormattedSelection,
  type PdfRect,
} from './pdf-editor-session.js';
import {
  commitIsolatedRedactions,
  createRandomId,
  queueIsolatedSelection,
  restoreRedactionSession,
  selectionRects,
  unionRects,
  type IsolatedRedactionSession,
} from './pdf-redaction-session.js';

const DEFAULT_TRANSPARENT_EDITING = true;
const MAX_REPLACEMENT_CHARACTERS = 10_000;

type CurrentTextSelection = {
  documentId: string;
  selectionScope: any;
  formattedSelection: FormattedSelection[];
};

export function installTextEditingPanel(
  pdfWrapper: HTMLElement,
  registry: any,
  session: PdfEditorSession,
  activeDocumentId: () => string | null
): void {
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
    'Select one or more lines of existing PDF text. Removal is destructive and transparent: no cover box, fill, or background is added. Signed PDFs and uncertain partial operations are blocked.';

  const removeButton = document.createElement('button');
  removeButton.id = 'remove-selected-text-btn';
  removeButton.className =
    'w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 px-4 rounded-lg transition-colors';
  removeButton.textContent = 'Remove Selected Text';
  removeButton.onclick = () => {
    void removeSelectedText(registry, session, activeDocumentId);
  };

  const replaceButton = document.createElement('button');
  replaceButton.id = 'replace-selected-text-btn';
  replaceButton.className =
    'w-full bg-gray-700 hover:bg-gray-600 text-white font-medium py-2.5 px-4 rounded-lg transition-colors';
  replaceButton.textContent = 'Replace Selected Text';
  replaceButton.onclick = () => {
    void replaceSelectedText(registry, session, activeDocumentId);
  };

  panel.append(heading, help, removeButton, replaceButton);
  pdfWrapper.appendChild(panel);
  createIcons({ icons });
}

function getCurrentTextSelection(
  registry: any,
  activeDocumentId: () => string | null
): CurrentTextSelection | null {
  const documentId = activeDocumentId();
  if (!documentId) {
    showAlert('No Active PDF', 'Open a PDF before editing text.');
    return null;
  }

  const selectionCapability = registry
    .getPlugin('selection')
    .provides() as any;
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

async function removeSelectedText(
  registry: any,
  session: PdfEditorSession,
  activeDocumentId: () => string | null
): Promise<void> {
  const current = getCurrentTextSelection(registry, activeDocumentId);
  if (!current || !session.beginOperation('text removal')) return;

  showLoader('Checking and removing selected text...');
  let redactionSession: IsolatedRedactionSession | null = null;

  try {
    await session.requireSafeMutationBaseline(current.documentId);
    session.assertDocumentStillActive(current.documentId);

    redactionSession = await queueIsolatedSelection(
      registry,
      current.documentId,
      current.formattedSelection
    );
    await commitIsolatedRedactions(redactionSession);
    session.recordTouchedPages(
      current.documentId,
      current.formattedSelection
    );
  } catch (error) {
    if (redactionSession?.commitStarted) {
      session.markUnsafe(
        current.documentId,
        'A text-removal commit failed after the engine started processing it. Some pages may have been changed while others were not.'
      );
    } else if (redactionSession && !redactionSession.closed) {
      restoreRedactionSession(redactionSession);
    }

    console.error('Error removing selected PDF text:', error);
    const message = error instanceof Error ? error.message : String(error);
    showAlert(
      'Remove Text Failed',
      `${message}${
        redactionSession?.commitStarted
          ? '\n\nThe in-memory copy is now blocked from download. Reload the original PDF before trying again.'
          : ''
      }`
    );
  } finally {
    hideLoader();
    session.endOperation();
  }
}

function makeTransparentFreeTextAnnotation(
  defaults: Record<string, any>,
  pageIndex: number,
  rect: PdfRect,
  contents: string
): Record<string, any> {
  const annotation: Record<string, any> = {
    ...defaults,
    id: createRandomId('replace'),
    pageIndex,
    rect,
    contents,
    fontSize: estimateReplacementFontSize(rect, contents),
    fontColor: '#000000',
    opacity: 1,
  };

  if (DEFAULT_TRANSPARENT_EDITING) {
    annotation.color = 'transparent';
    annotation.backgroundColor = 'transparent';
    annotation.strokeColor = 'transparent';
    annotation.strokeWidth = 0;
    annotation.borderWidth = 0;
    delete annotation.fillColor;
    delete annotation.borderColor;
  }

  return annotation;
}

async function rollbackReplacementAnnotation(
  annotationScope: any,
  pageIndex: number,
  annotationId: string
): Promise<boolean> {
  try {
    if (!annotationScope.getAnnotationById?.(annotationId)) return false;

    annotationScope.deleteAnnotation(pageIndex, annotationId);
    const rolledBack = await annotationScope.commit().toPromise();
    if (!rolledBack) return false;

    return !annotationScope.getAnnotationById?.(annotationId);
  } catch (error) {
    console.error('Failed to roll back replacement annotation:', error);
    return false;
  }
}

async function replaceSelectedText(
  registry: any,
  session: PdfEditorSession,
  activeDocumentId: () => string | null
): Promise<void> {
  const current = getCurrentTextSelection(registry, activeDocumentId);
  if (!current || !session.beginOperation('text replacement')) return;

  const { documentId, selectionScope, formattedSelection } = current;
  let redactionSession: IsolatedRedactionSession | null = null;
  let annotationScope: any = null;
  let annotationId: string | null = null;
  let annotationMayHaveCommitted = false;

  try {
    const pageIndexes = new Set(
      formattedSelection.map((selection) => selection.pageIndex)
    );
    const rects = selectionRects(formattedSelection);
    if (pageIndexes.size !== 1 || rects.length === 0) {
      throw new Error(
        'Replacement supports a multi-line block on one page. Use Remove Selected Text for a selection spanning multiple pages.'
      );
    }

    const selectedTextParts = await selectionScope
      .getSelectedText()
      .toPromise();
    const originalText = (selectedTextParts ?? []).join('\n').trim();
    const replacement = window.prompt(
      'Replace the selected text block with:',
      originalText
    );

    if (replacement === null || replacement === originalText) return;
    if (replacement.length > MAX_REPLACEMENT_CHARACTERS) {
      throw new Error(
        `Replacement text is limited to ${MAX_REPLACEMENT_CHARACTERS.toLocaleString()} characters.`
      );
    }

    showLoader('Checking and replacing selected text...');
    await session.requireSafeMutationBaseline(documentId);
    session.assertDocumentStillActive(documentId);

    const pageIndex = formattedSelection[0].pageIndex;
    const replacementRect = unionRects(rects);
    let annotation: Record<string, any> | null = null;

    if (replacement.length > 0) {
      const annotationCapability = registry
        .getPlugin('annotation')
        .provides() as any;
      const freeTextTool = annotationCapability.getTool('freeText');
      if (!freeTextTool) {
        throw new Error('The Free Text annotation tool is unavailable.');
      }

      annotationScope = annotationCapability.forDocument(documentId);
      annotation = makeTransparentFreeTextAnnotation(
        freeTextTool.defaults ?? {},
        pageIndex,
        replacementRect,
        replacement
      );
      annotationId = String(annotation.id);
    }

    redactionSession = await queueIsolatedSelection(
      registry,
      documentId,
      formattedSelection
    );

    if (annotation && annotationScope && annotationId) {
      annotationScope.createAnnotation(pageIndex, annotation);
      annotationMayHaveCommitted = true;
      const committed = await annotationScope.commit().toPromise();
      if (!committed || !annotationScope.getAnnotationById?.(annotationId)) {
        throw new Error(
          'The PDF engine did not confirm creation of the replacement text.'
        );
      }
    }

    await commitIsolatedRedactions(redactionSession);
    session.recordTouchedPages(documentId, formattedSelection);
    if (annotationId) {
      session.recordAnnotationAddition(documentId, pageIndex);
    }
  } catch (error) {
    let rollbackFailed = false;
    if (annotationMayHaveCommitted && annotationScope && annotationId) {
      rollbackFailed = !(
        await rollbackReplacementAnnotation(
          annotationScope,
          formattedSelection[0]?.pageIndex ?? 0,
          annotationId
        )
      );
    }

    if (redactionSession?.commitStarted) {
      session.markUnsafe(
        documentId,
        'A replacement operation failed after permanent text removal started. The PDF may contain a partial edit.'
      );
    } else if (rollbackFailed) {
      session.markUnsafe(
        documentId,
        'The replacement annotation could not be rolled back after an operation failed.'
      );
    }

    if (redactionSession && !redactionSession.closed) {
      restoreRedactionSession(redactionSession);
    }

    console.error('Error replacing selected PDF text:', error);
    const message = error instanceof Error ? error.message : String(error);
    const blocked =
      redactionSession?.commitStarted || rollbackFailed
        ? '\n\nThe in-memory copy is now blocked from download. Reload the original PDF before trying again.'
        : '';
    showAlert('Replace Text Failed', `${message}${blocked}`);
  } finally {
    hideLoader();
    session.endOperation();
  }
}

function estimateReplacementFontSize(
  rect: PdfRect,
  replacement: string
): number {
  const lines = replacement.split(/\r?\n/);
  const lineCount = Math.max(1, lines.length);
  let fontSize = Math.max(
    5,
    Math.min(72, (rect.size.height / lineCount) * 0.78)
  );
  if (!replacement) return fontSize;

  const context = document.createElement('canvas').getContext('2d');
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
