import { type BaseProps } from '@/lib/tsx.utils';

export function FormLayout(props: BaseProps) {
  return <div class="flex flex-col gap-4">{props.children}</div>;
}
