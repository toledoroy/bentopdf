import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/js/ui.js', () => ({
  hideLoader: vi.fn(),
  showAlert: vi.fn(),
  showLoader: vi.fn(),
}));

vi.mock('@/js/utils/helpers.js', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('@/js/utils/pdf-preservation-guard.js', () => ({
  createPdfPreservationSnapshot: vi.fn(),
  verifyPdfPreservation: vi.fn(),
}));

import { PdfEditorSession } from '@/js/logic/pdf-editor-session.js';

describe('PdfEditorSession', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('installs the verified download control without mutating an immutable viewer export capability', () => {
    const session = new PdfEditorSession(() => null);
    const wrapper = document.createElement('div');
    const immutableExportCapability = Object.freeze({});
    const registry = {
      getPlugin: vi.fn(() => ({
        provides: () => immutableExportCapability,
      })),
    };

    expect(() =>
      session.installDownloadButton(wrapper, registry)
    ).not.toThrow();
    expect(
      wrapper.querySelector<HTMLButtonElement>('#download-edited-pdf')
        ?.textContent
    ).toBe('Download Edited PDF');
  });
});
