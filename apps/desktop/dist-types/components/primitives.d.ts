import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
/**
 * The small set of building blocks every screen uses.
 *
 * Kept deliberately few. Each new variant is a decision that has to be repeated
 * consistently everywhere, and a tool this size does not need many.
 */
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export declare function Button({ variant, loading, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    loading?: boolean;
}): ReactNode;
export declare function Field({ label, hint, error, children, }: {
    label: string;
    hint?: string;
    error?: string;
    children: ReactNode;
}): ReactNode;
export declare function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode;
export declare function Card({ children, ...rest }: {
    children: ReactNode;
} & {
    className?: string;
}): ReactNode;
/** Status pill. `tone` maps to the state colours, not to arbitrary hues. */
export declare function Badge({ tone, children, }: {
    tone?: 'running' | 'stopped' | 'pending' | 'danger' | 'neutral';
    children: ReactNode;
}): ReactNode;
/**
 * What to show where nothing exists yet.
 *
 * Never just "no items": an empty screen is the moment someone most needs to
 * know what to do next, so the way forward is part of the component.
 */
export declare function EmptyState({ title, hint, action, }: {
    title: string;
    hint: string;
    action?: ReactNode;
}): ReactNode;
export {};
//# sourceMappingURL=primitives.d.ts.map