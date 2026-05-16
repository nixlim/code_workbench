import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-tertiary text-gray-700 border border-border-muted',
        success: 'bg-success-subtle text-success-fg border border-success-muted',
        attention: 'bg-attention-subtle text-attention-fg border border-attention-muted',
        danger: 'bg-danger-subtle text-danger-fg border border-danger-muted',
        accent: 'bg-accent-subtle text-accent-fg border border-accent-fg/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
