import * as React from 'react';
import { XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Wrapped in forwardRef (rather than a plain function component) because
// preact/compat drops the ref on plain function components, and
// ClearableInput below needs a ref to focus the input after clearing.
// See https://github.com/preactjs/preact/issues/3297.
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

const ClearableInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, value, defaultValue, onInput, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    const [hasValue, setHasValue] = React.useState(() => Boolean(value ?? defaultValue));

    React.useEffect(() => {
      if (value !== undefined) {
        setHasValue(String(value).length > 0);
      }
    }, [value]);

    function handleClear() {
      const inputEl = inputRef.current;
      if (!inputEl) return;
      inputEl.value = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.focus();
    }

    return (
      <div className="flex items-center bg-input border-input rounded w-fit">
        <Input
          ref={inputRef}
          value={value}
          defaultValue={defaultValue}
          onInput={(e) => {
            setHasValue(e.currentTarget.value.length > 0);
            onInput?.(e);
          }}
          className={cn(
            hasValue && 'pr-7',
            'border-none bg-transparent! shadow-none outline-0 focus-visible:border-transparent focus-visible:ring-0',
            className,
          )}
          {...props}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          tabIndex={-1}
          className={hasValue ? 'pointer-events-auto' : 'opacity-0 pointer-events-none'}
          onClick={handleClear}
        >
          <XIcon />
          <span className="sr-only">Clear</span>
        </Button>
      </div>
    );
  },
);
ClearableInput.displayName = 'ClearableInput';

export { Input, ClearableInput };
