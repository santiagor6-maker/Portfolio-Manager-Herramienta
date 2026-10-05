// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '../i18n';
import { Delta, Money } from '../components/ui';
import { useApp } from '../store/app';
import { DEFAULT_SETTINGS } from '../db/repo';

const nb = (s: string | null) => (s ?? '').replace(/ /g, ' ');

describe('<Money> follows global currency, language and privacy', () => {
  beforeEach(() => {
    cleanup();
    useApp.setState({ settings: { ...DEFAULT_SETTINGS }, analysis: undefined });
  });

  it('re-renders when the reporting currency / language changes', () => {
    render(<Money value={1234.56} />);
    expect(nb(screen.getByText(/1\.23/).textContent)).toBe('$ 1.235');
    act(() => useApp.setState({ settings: { ...DEFAULT_SETTINGS, reportingCurrency: 'BRL', language: 'pt' } }));
    expect(nb(screen.getByText(/R\$/).textContent)).toBe('R$ 1.234,56');
    act(() => useApp.setState({ settings: { ...DEFAULT_SETTINGS, reportingCurrency: 'USD', language: 'en' } }));
    expect(screen.getByText('$1,234.56')).toBeTruthy();
  });

  it('hides amounts in privacy mode', () => {
    useApp.setState({ settings: { ...DEFAULT_SETTINGS, privacy: true } });
    render(<Money value={99} />);
    expect(screen.getByText('•••••')).toBeTruthy();
  });

  it('Delta pairs colour with an arrow and sign (colourblind-safe)', () => {
    const { container } = render(<Delta pct={-0.05} />);
    expect(container.textContent).toContain('-5,00');
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.firstElementChild?.className).toContain('text-neg');
  });
});
