import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'h-8 w-full rounded-md border border-border-default bg-surface px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-accent-fg focus:outline-none focus:ring-1 focus:ring-accent-fg disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-100',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
