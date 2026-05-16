import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => {
    return (
      <select
        className={cn(
          'h-8 rounded-md border border-border-default bg-surface px-2 pr-8 text-sm text-gray-900 focus:border-accent-fg focus:outline-none focus:ring-1 focus:ring-accent-fg disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-100 appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2716%27%20height%3D%2716%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%236e7781%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpolyline%20points%3D%276%209%2012%2015%2018%209%27/%3E%3C/svg%3E")] bg-[length:16px] bg-[right_6px_center] bg-no-repeat',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Select.displayName = 'Select';

export { Select };
