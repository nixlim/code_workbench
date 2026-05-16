import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from './dialog';
import { Button } from './button';
import { Input } from './input';

type ConfirmVariant = 'danger' | 'primary';

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  withReason?: boolean;
  reasonLabel?: string;
  defaultReason?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
  reason?: string;
}

type ConfirmFn = (request: ConfirmRequest) => Promise<ConfirmResult>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [reason, setReason] = useState('');
  const resolverRef = useRef<((result: ConfirmResult) => void) | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const settle = useCallback((result: ConfirmResult) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((next) => {
    setReason(next.defaultReason ?? '');
    setRequest(next);
    return new Promise<ConfirmResult>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={request !== null}
        onClose={() => settle({ confirmed: false })}
        labelledBy="confirm-dialog-title"
        className="max-w-md"
        initialFocusRef={confirmBtnRef}
      >
        {request && (
          <div className="p-4 space-y-4">
            <div className="space-y-1.5">
              <h3 id="confirm-dialog-title" className="m-0 text-base font-semibold text-gray-900">{request.title}</h3>
              {request.body && <div className="text-sm text-gray-600">{request.body}</div>}
            </div>
            {request.withReason && (
              <label className="block space-y-1">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{request.reasonLabel ?? 'Reason'}</span>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional reason" />
              </label>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button onClick={() => settle({ confirmed: false })}>{request.cancelLabel ?? 'Cancel'}</Button>
              <Button
                ref={confirmBtnRef}
                variant={request.variant === 'danger' ? 'danger' : 'primary'}
                onClick={() => settle({ confirmed: true, reason: request.withReason ? reason : undefined })}
              >
                {request.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}
