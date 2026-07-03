import { render, screen } from '@testing-library/preact';
import { App } from '../src/app';

describe('App', () => {
  it('renders the heading', () => {
    render(<App />);
    expect(screen.getByText('Amazing Hashbrown')).toBeInTheDocument();
  });
});
