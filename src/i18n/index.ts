import i18next from 'i18next';
import ko from './ko.json';
import en from './en.json';

export type Locale = 'ko' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['ko', 'en'] as const;

/** 기준 언어는 ko, 폴백은 en (DIRECTION.md 3.6) */
export const FALLBACK_LOCALE: Locale = 'en';

/**
 * OS 로케일 문자열을 지원 언어로 환산한다.
 *
 * DIRECTION.md 3.6 — OS 가 한국어(`ko-*`)일 때만 한국어, 그 외는 전부 영어.
 * `app.getLocale()` 이 주는 값을 그대로 넘기면 된다 (예: 'ko-KR', 'en-US', 'ja-JP').
 */
export function resolveLocale(osLocale: string): Locale {
  return osLocale.toLowerCase().startsWith('ko') ? 'ko' : FALLBACK_LOCALE;
}

/**
 * 메인 · 렌더러가 **각각** 호출한다. 두 프로세스는 메모리를 공유하지 않는다.
 * 언어의 단일 진실원은 메인이고, 변경은 IPC 로 렌더러에 통보한다 (DIRECTION.md 3.6).
 */
export async function initI18n(locale: Locale) {
  await i18next.init({
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as string[],
    resources: {
      ko: { translation: ko },
      en: { translation: en },
    },
  });
  return i18next;
}

export async function changeLocale(locale: Locale) {
  await i18next.changeLanguage(locale);
}

export function currentLocale(): Locale {
  return (i18next.resolvedLanguage as Locale) ?? FALLBACK_LOCALE;
}

export const t = i18next.t.bind(i18next);

export default i18next;
