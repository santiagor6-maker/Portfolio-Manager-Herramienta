// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import '../i18n';

const results = [{ id: 'XNAS:MSFT', symbol: 'MSFT', name: 'Microsoft', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity', origin: 'catalog' }];
vi.mock('../services/marketData', () => ({
  searchInstruments: vi.fn(() => new Promise((r) => setTimeout(() => r({ results, offline: false }), 300))),
}));

const { InstrumentPicker } = await import('../components/InstrumentPicker');

describe('W1 InstrumentPicker never creates a phantom manual instrument', () => {
  it('fast Enter waits for results and picks the exact symbol match', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onCreateManual = vi.fn();
    const { getByRole, queryByText } = render(<InstrumentPicker onChange={onChange} onCreateManual={onCreateManual} inputId="p" />);
    const input = getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'MSFT' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // While searching there is no "create manual" option and nothing was created.
    expect(queryByText(/Crear activo manual/)).toBeNull();
    expect(onCreateManual).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(onCreateManual).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'XNAS:MSFT' }));
    vi.useRealTimers();
    cleanup();
  });
});
