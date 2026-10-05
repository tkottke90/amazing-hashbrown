import { fireEvent, render, screen } from '@testing-library/preact';
import { CredentialValueField } from '@/components/credential-value-field';

describe('CredentialValueField', () => {
  it('starts in literal mode for a plain value [unit]', () => {
    render(<CredentialValueField id="tok" label="Token" value="ghp_abc" onChange={jest.fn()} />);
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Token')).toHaveValue('ghp_abc');
  });

  it('starts in env mode and prefills the captured name for a ${VAR} value [unit]', () => {
    render(
      <CredentialValueField id="tok" label="Token" value="${GH_TOKEN}" onChange={jest.fn()} />,
    );
    expect(
      screen.getByRole('switch', { name: 'Source Token from an environment variable' }),
    ).toBeChecked();
    expect(screen.getByPlaceholderText('GH_TOKEN')).toHaveValue('GH_TOKEN');
  });

  it('composes ${NAME} as the env-var name is typed [unit]', () => {
    const onChange = jest.fn();
    render(<CredentialValueField id="tok" label="Token" value="${GH_TOKEN}" onChange={onChange} />);
    fireEvent.input(screen.getByPlaceholderText('GH_TOKEN'), { target: { value: 'MY_PAT' } });
    expect(onChange).toHaveBeenCalledWith('${MY_PAT}');
  });

  it('switching to env mode prefills the suggested name and emits it immediately [unit]', () => {
    const onChange = jest.fn();
    render(
      <CredentialValueField
        id="tok"
        label="Token"
        value=""
        onChange={onChange}
        suggestedEnvName="GH_TOKEN"
      />,
    );
    fireEvent.click(
      screen.getByRole('switch', { name: 'Source Token from an environment variable' }),
    );
    expect(onChange).toHaveBeenCalledWith('${GH_TOKEN}');
    expect(screen.getByDisplayValue('GH_TOKEN')).toBeInTheDocument();
  });

  it('switching back to literal mode clears the value [unit]', () => {
    const onChange = jest.fn();
    render(<CredentialValueField id="tok" label="Token" value="${GH_TOKEN}" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole('switch', { name: 'Source Token from an environment variable' }),
    );
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('typing a literal value calls onChange with the raw text [unit]', () => {
    const onChange = jest.fn();
    render(<CredentialValueField id="tok" label="Token" value="" onChange={onChange} />);
    fireEvent.input(screen.getByLabelText('Token'), { target: { value: 'ghp_new' } });
    expect(onChange).toHaveBeenCalledWith('ghp_new');
  });

  it('masked=false renders plain text, never a password input or the MASK sentinel look [unit]', () => {
    render(
      <CredentialValueField
        id="env-val"
        label="Value"
        value="some-literal"
        onChange={jest.fn()}
        masked={false}
      />,
    );
    expect(screen.getByLabelText('Value')).toHaveAttribute('type', 'text');
  });
});
