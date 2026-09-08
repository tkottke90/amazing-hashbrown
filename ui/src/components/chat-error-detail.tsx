import { useSignal } from '@preact/signals';
import {
  KeyRound,
  CreditCard,
  Timer,
  FileX,
  ShieldAlert,
  CloudOff,
  WifiOff,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-preact';
import type { ChatErrorCategory } from '@tkottke90/llm-common-types/chat';

interface ChatErrorDetailProps {
  category?: ChatErrorCategory;
  // The raw provider failure text (assistant.error) — shown as expandable
  // detail underneath the category's own copy, never in place of it. See
  // docs/superpowers/specs/2026-09-08-chat-error-classification-design.md §3.
  detail?: string;
}

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

const CATEGORY_INFO: Record<ChatErrorCategory, { icon: typeof AlertTriangle; message: string }> = {
  auth: {
    icon: KeyRound,
    message: 'Authentication failed — check that your API key for this provider is valid.',
  },
  billing: {
    icon: CreditCard,
    message:
      "This provider account is out of credit or has a billing issue. Retrying won't help until that's resolved.",
  },
  rate_limit: {
    icon: Timer,
    message: 'The provider is rate-limiting requests. Wait a bit before retrying.',
  },
  context_length: {
    icon: FileX,
    message:
      "This conversation is too long for the model's context window. Try starting a new thread or shortening it.",
  },
  content_policy: {
    icon: ShieldAlert,
    message:
      "The provider declined this request for policy reasons. Rephrasing may help; retrying as-is won't.",
  },
  unavailable: {
    icon: CloudOff,
    message:
      'The model or provider is temporarily unavailable. This is usually transient — retrying may work.',
  },
  network: {
    icon: WifiOff,
    message: "Couldn't reach the provider — check your connection.",
  },
  unknown: {
    icon: AlertTriangle,
    message: GENERIC_MESSAGE,
  },
};

export function ChatErrorDetail({ category, detail }: ChatErrorDetailProps) {
  const isOpen = useSignal(false);

  if (!category) {
    return <span>{GENERIC_MESSAGE}</span>;
  }

  const { icon: Icon, message } = CATEGORY_INFO[category];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" />
        <span>{message}</span>
      </div>
      {detail && (
        <div>
          <button
            type="button"
            onClick={() => {
              isOpen.value = !isOpen.value;
            }}
            className="flex items-center gap-1 text-xs opacity-70 hover:opacity-100 transition-opacity"
          >
            {isOpen.value ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            Show details
          </button>
          {isOpen.value && <p className="mt-1 text-xs opacity-80 break-words">{detail}</p>}
        </div>
      )}
    </div>
  );
}
