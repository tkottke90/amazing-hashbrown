import { fireEvent, render, screen } from '@testing-library/preact';
import { SettingsNav } from '@/pages/settings/settings-nav';

const NAV_LABELS = [
  'General',
  'Storage',
  'Model providers',
  'Embeddings',
  'Agent behavior',
  'Tools',
  'Cost rates',
  'MCP Servers',
  'Skills',
];

describe('SettingsNav', () => {
  it('renders all 9 nav labels', () => {
    const onNavigate = jest.fn();
    render(<SettingsNav activeSlug="general" onNavigate={onNavigate} />);
    for (const label of NAV_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('marks the active item with data-active="true" and others as false', () => {
    render(<SettingsNav activeSlug="storage" onNavigate={jest.fn()} />);
    const items = screen.getAllByRole('button');
    const active = items.find((btn) => btn.textContent === 'Storage');
    const other = items.find((btn) => btn.textContent === 'General');
    expect(active).toHaveAttribute('data-active', 'true');
    expect(other).toHaveAttribute('data-active', 'false');
  });

  it('calls onNavigate with the correct slug when a nav item is clicked', () => {
    const onNavigate = jest.fn();
    render(<SettingsNav activeSlug="general" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Embeddings'));
    expect(onNavigate).toHaveBeenCalledWith('embeddings');
  });

  it('calls onNavigate with "mcp-servers" when MCP Servers is clicked', () => {
    const onNavigate = jest.fn();
    render(<SettingsNav activeSlug="general" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('MCP Servers'));
    expect(onNavigate).toHaveBeenCalledWith('mcp-servers');
  });

  it('has data-slot="settings-nav-item" on every button', () => {
    render(<SettingsNav activeSlug="general" onNavigate={jest.fn()} />);
    const items = screen.getAllByRole('button');
    expect(items.length).toBe(9);
    for (const item of items) {
      expect(item).toHaveAttribute('data-slot', 'settings-nav-item');
    }
  });
});
