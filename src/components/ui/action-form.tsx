"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";

import type { ActionResult } from "@/lib/errors/app-error";

import { BUTTON_VARIANTS, type ButtonVariant } from "./primitives";
import { useToast } from "./toast";

type FormAction<T> = (prev: ActionResult<T> | null, formData: FormData) => Promise<ActionResult<T>>;

const FieldErrorsContext = createContext<Record<string, string[]>>({});

/**
 * Accessible form bound to a Server Function returning ActionResult.
 * - Field errors are attached to their inputs (aria-invalid, aria-describedby).
 * - Focus moves to the first invalid field (or the error summary).
 * - Results are also announced as toast notifications.
 * Presentation only: authorization is enforced on the server and in the DB.
 */
export function ActionForm<T>({
  action,
  submitLabel,
  children,
  className = "flex max-w-2xl flex-col gap-3",
  confirmMessage,
  variant = "primary",
  toastOnSuccess = true,
}: {
  action: FormAction<T>;
  submitLabel: string;
  children?: ReactNode;
  className?: string;
  confirmMessage?: string;
  variant?: ButtonVariant;
  toastOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const summaryId = useId();

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      if (toastOnSuccess && typeof state.data === "string") toast("success", state.data);
      return;
    }
    toast("error", state.error.message);
    const firstInvalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (firstInvalid ?? summaryRef.current)?.focus();
  }, [state, toast, toastOnSuccess]);

  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};

  return (
    <FieldErrorsContext.Provider value={fieldErrors}>
      <form
        ref={formRef}
        action={formAction}
        className={className}
        aria-describedby={state && !state.ok ? summaryId : undefined}
        onSubmit={(event) => {
          if (confirmMessage && !window.confirm(confirmMessage)) event.preventDefault();
        }}
      >
        {children}
        <div>
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className={BUTTON_VARIANTS[variant]}
          >
            {pending ? "Working…" : submitLabel}
          </button>
        </div>
        {state && !state.ok ? (
          <div
            id={summaryId}
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="text-sm text-[var(--danger)]"
          >
            <p>{state.error.message}</p>
            {state.error.requestId ? (
              <p className="text-xs opacity-80">Reference: {state.error.requestId}</p>
            ) : null}
          </div>
        ) : null}
        {state && state.ok && typeof state.data === "string" ? (
          <p role="status" className="text-sm text-[var(--success)]">
            {state.data}
          </p>
        ) : null}
      </form>
    </FieldErrorsContext.Provider>
  );
}

function useFieldError(name: string) {
  const errors = useContext(FieldErrorsContext)[name];
  return errors && errors.length > 0 ? errors.join(" ") : undefined;
}

const INPUT_CLASS =
  "rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 aria-[invalid=true]:border-[var(--danger)]";

export function Field({
  label,
  name,
  type = "text",
  required,
  autoComplete,
  defaultValue,
  hint,
  hideLabel,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
  hint?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  const error = useFieldError(name);
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {required ? (
          <span aria-hidden className="text-[var(--danger)]">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        aria-required={required}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={INPUT_CLASS}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-[var(--muted)]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  name,
  options,
  defaultValue,
  hideLabel,
}: {
  label: string;
  name: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
  hideLabel?: boolean;
}) {
  const id = useId();
  const error = useFieldError(name);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={INPUT_CLASS}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
