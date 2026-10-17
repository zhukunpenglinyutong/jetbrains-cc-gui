/** Current picker capabilities, shared by selectors and every model send path. */
let contextModels = new Set<string>();

export function updateClaudeModelCapabilities(models: ReadonlyArray<{ id: string; supports1MContext?: boolean }>): void {
  contextModels = new Set(models.filter(model => model.supports1MContext === true).map(model => model.id));
}

export function pickerModelSupports1MContext(modelId: string): boolean {
  return contextModels.has(modelId.replace(/\[1m\]$/i, ''));
}
