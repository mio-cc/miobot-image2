import { CONFIG_PACKAGE } from '@miobot-v2/config';
import { CORE_PACKAGE } from '@miobot-v2/core';

export function describeBotAppSkeleton() {
  return {
    app: '@miobot-v2/app-bot',
    phase: 'P2-skeleton' as const,
    packages: [CORE_PACKAGE.name, CONFIG_PACKAGE.name],
  };
}
