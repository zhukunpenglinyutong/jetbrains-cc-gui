/** Question id for a form-mode MCP elicitation that has no fields to fill in. */
export const CODEX_EMPTY_FORM_QUESTION_ID = '__codex_empty_form__';
export const CODEX_EMPTY_FORM_ALLOW_LABEL = 'Allow';
export const CODEX_EMPTY_FORM_DENY_LABEL = 'Deny';

/** True only for a well-formed schema whose `properties` is an empty object. */
export function isEmptyFormSchema(schema: Record<string, unknown> | undefined): boolean {
  const properties = schema?.properties;
  return !!properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
    && Object.keys(properties).length === 0;
}
