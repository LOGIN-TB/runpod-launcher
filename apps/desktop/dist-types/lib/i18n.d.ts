import { type ReactNode } from 'react';
import { type Locale, type MessageKey, type Vars } from '@runpod-launcher/i18n';
interface I18nValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (key: MessageKey, vars?: Vars) => string;
    /** Locale-aware money and number formatting, so strings never hard-code separators. */
    money: (usd: number) => string;
    number: (value: number, options?: Intl.NumberFormatOptions) => string;
}
export declare function I18nProvider({ children }: {
    children: ReactNode;
}): ReactNode;
export declare function useI18n(): I18nValue;
export {};
//# sourceMappingURL=i18n.d.ts.map