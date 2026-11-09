export interface MistControl {
  root: HTMLElement;
  destroy(): void;
}

export interface MistOptions {
  host?: string | Element;
  sidebar?: string;
  variant?: 'lite' | 'sil';
  side?: boolean;
  scroller?: string;
  parallax?: boolean;
}

export function mountMist(opts?: MistOptions): MistControl | null;
export function wallArt(
  scope?: string,
  box?: string,
  fit?: 'slice' | 'meet',
  variant?: 'lite' | 'sil',
  soft?: boolean,
): string;
