interface FieldErrorProps {
  errors?: string[];
}

export function FieldError({ errors }: FieldErrorProps) {
  if (!errors || errors.length === 0) return null;
  return <p class="mt-1 text-xs text-destructive">{errors[0]}</p>;
}
