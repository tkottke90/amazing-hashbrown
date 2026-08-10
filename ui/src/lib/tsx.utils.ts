import { type RenderableProps } from 'preact'

export type ComponentProps = Record<string, unknown> & {
  className?: string
}

export type Nullable<T> = T | null

export type BaseProps<
  TProps extends ComponentProps = ComponentProps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRef = any,
> = RenderableProps<TProps & ComponentProps, TRef>