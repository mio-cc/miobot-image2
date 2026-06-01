import { createPanelViewModel, renderPanelShell, WEB_PANEL_PACKAGE } from '../../../packages/web-panel/src/index.js';

export function describePanelAppSkeleton() {
  return {
    app: '@miobot-v2/app-panel',
    phase: 'P11-web-panel' as const,
    packages: [WEB_PANEL_PACKAGE.name],
  };
}

export function renderPanelApp(config: unknown) {
  const viewModel = createPanelViewModel(config);
  return {
    app: '@miobot-v2/app-panel',
    phase: 'P11-web-panel' as const,
    shell: renderPanelShell(viewModel),
    viewModel,
  };
}
