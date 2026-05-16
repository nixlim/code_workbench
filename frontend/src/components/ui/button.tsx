import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'border border-border-default bg-surface text-gray-700 shadow-sm hover:bg-surface-secondary active:bg-surface-tertiary',
        primary:
          'bg-accent-emphasis text-white border border-transparent hover:bg-accent-fg active:brightness-110',
        ghost:
          'text-gray-600 hover:bg-surface-secondary hover:text-gray-900 active:bg-surface-tertiary',
        danger:
          'border border-danger-muted bg-danger-subtle text-danger-fg hover:bg-danger-muted/30 active:bg-danger-muted/50',
        success:
          'border border-success-muted bg-success-subtle text-success-fg hover:bg-success-muted/30',
        attention:
          'border border-attention-muted bg-attention-subtle text-attention-fg hover:bg-attention-muted/30',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-8 px-3 text-sm',
        lg: 'h-9 px-4 text-sm',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
